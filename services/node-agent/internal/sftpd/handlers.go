package sftpd

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"

	"github.com/blockforge/node-agent/internal/fsops"
	"github.com/blockforge/node-agent/internal/protocol"
)

// handler implements pkg/sftp's request-server interfaces on one workload sandbox.
type handler struct {
	c    *conn
	root *fsops.Root
	act  *activity
}

// sftpError carries a client-safe message and an SFTP status code.
type sftpError struct {
	code error
	msg  string
}

func (e *sftpError) Error() string { return e.msg }
func (e *sftpError) Unwrap() error { return e.code }

func denied(msg string) error { return &sftpError{code: sftp.ErrSSHFxPermissionDenied, msg: msg} }

// toSFTP maps sandbox / protocol errors to SFTP status codes without exposing host paths.
func toSFTP(op, rel string, err error) error {
	if err == nil {
		return nil
	}
	var se *sftpError
	if errors.As(err, &se) {
		return se
	}
	if _, ok := protocol.AsError(err); !ok {
		err = fsops.MapError(op, rel, err)
	}
	pe, _ := protocol.AsError(err)
	switch pe.Code {
	case protocol.CodeNotFound:
		return &sftpError{code: sftp.ErrSSHFxNoSuchFile, msg: pe.Message}
	case protocol.CodePathForbidden:
		return &sftpError{code: sftp.ErrSSHFxPermissionDenied, msg: pe.Message}
	case protocol.CodeValidationFailed:
		return &sftpError{code: sftp.ErrSSHFxBadMessage, msg: pe.Message}
	}
	return &sftpError{code: sftp.ErrSSHFxFailure, msg: pe.Message}
}

// rel converts an SFTP path ("/world/x", cleaned by pkg/sftp) into a sandbox path.
func rel(p string) (string, error) {
	r := strings.TrimPrefix(path.Clean("/"+p), "/")
	if r == "" {
		return ".", nil
	}
	return fsops.CleanPath(r, false)
}

func display(r string) string {
	if r == "." {
		return ""
	}
	return r
}

// check resolves the path, enforces the permission and returns a sandbox view that enforces the
// session's denylist on requested AND symlink-resolved paths (and on directory contents for tree
// operations). Every setstat-like or write operation passes mutate=true, so the data root itself can
// never be modified.
func (h *handler) check(p, need string, mutate bool) (*fsops.Root, string, error) {
	perms, deny, ok := h.c.access()
	if !ok {
		return nil, "", denied("session expired")
	}
	if !perms[need] {
		return nil, "", denied("permission denied")
	}
	r, err := rel(p)
	if err != nil {
		return nil, "", toSFTP("access", p, err)
	}
	if mutate && r == "." {
		return nil, "", denied("the server root cannot be modified")
	}
	return h.root.WithDenylist(deny), r, nil
}

// --- reads -------------------------------------------------------------------------------

// Fileread opens a regular file for reading (FIFOs/devices are refused without blocking).
func (h *handler) Fileread(req *sftp.Request) (io.ReaderAt, error) {
	root, r, err := h.check(req.Filepath, "read", false)
	if err != nil {
		return nil, err
	}
	f, _, err := root.OpenForRead(r)
	if err != nil {
		return nil, toSFTP("open", display(r), err)
	}
	return f, nil
}

// --- writes ------------------------------------------------------------------------------

type writeFile struct {
	*os.File
	once   sync.Once
	finish func()
}

func (w *writeFile) Close() error {
	err := w.File.Close()
	w.once.Do(w.finish)
	return err
}

func (h *handler) openWrite(req *sftp.Request, needRead bool) (*writeFile, error) {
	root, r, err := h.check(req.Filepath, "write", true)
	if err != nil {
		return nil, err
	}
	if needRead {
		if perms, _, _ := h.c.access(); !perms["read"] {
			return nil, denied("permission denied")
		}
	}
	if err := root.CheckDenied(r); err != nil {
		return nil, toSFTP("open", display(r), err)
	}
	or := h.root.OSRoot()
	fi, statErr := or.Stat(r)
	exists := statErr == nil
	if statErr != nil && !errors.Is(statErr, fs.ErrNotExist) {
		return nil, toSFTP("open", display(r), statErr)
	}
	if exists && !fi.Mode().IsRegular() {
		return nil, denied("not a regular file")
	}
	pf := req.Pflags()
	// O_TRUNC is applied only after the opened file has been verified, so a symlink swapped in after
	// the denylist check can never truncate a protected file.
	flags := os.O_WRONLY
	if needRead || pf.Read {
		flags = os.O_RDWR
	}
	if pf.Creat {
		flags |= os.O_CREATE
	}
	if pf.Excl {
		flags |= os.O_EXCL
	}
	if pf.Append {
		flags |= os.O_APPEND
	}
	f, err := or.OpenFile(r, flags, 0o644)
	if err != nil {
		return nil, toSFTP("open", display(r), err)
	}
	if st, err := f.Stat(); err != nil || !st.Mode().IsRegular() {
		f.Close()
		return nil, denied("not a regular file")
	}
	if err := root.VerifyOpen(f, r); err != nil {
		f.Close()
		if !exists {
			_ = or.Remove(r)
		}
		return nil, toSFTP("open", display(r), err)
	}
	if pf.Trunc {
		if err := f.Truncate(0); err != nil {
			f.Close()
			return nil, toSFTP("open", display(r), err)
		}
	}
	if !exists {
		_ = h.root.ChownNew(r)
	}
	action := "write"
	if !exists || pf.Trunc {
		action = "upload"
	}
	return &writeFile{File: f, finish: func() { h.act.add(action, display(r), "") }}, nil
}

// Filewrite opens a file for writing (SFTP put).
func (h *handler) Filewrite(req *sftp.Request) (io.WriterAt, error) { return h.openWrite(req, false) }

// OpenFile opens a file for reading and writing.
func (h *handler) OpenFile(req *sftp.Request) (sftp.WriterAtReaderAt, error) {
	return h.openWrite(req, true)
}

// Filecmd handles setstat, rename, remove, rmdir, mkdir; links are refused.
func (h *handler) Filecmd(req *sftp.Request) error {
	switch req.Method {
	case "Symlink", "Link":
		return denied("creating links is not allowed")
	case "Setstat":
		return h.setstat(req)
	case "Rename":
		return h.rename(req, false)
	case "Remove", "Rmdir":
		root, r, err := h.check(req.Filepath, "write", true)
		if err != nil {
			return err
		}
		fi, err := h.root.OSRoot().Lstat(r)
		if err != nil {
			return toSFTP("delete", display(r), err)
		}
		if (req.Method == "Rmdir") != fi.IsDir() {
			if fi.IsDir() {
				return &sftpError{code: sftp.ErrSSHFxFailure, msg: "is a directory"}
			}
			return &sftpError{code: sftp.ErrSSHFxFailure, msg: "not a directory"}
		}
		if err := root.Delete(r, false); err != nil {
			return toSFTP("delete", display(r), err)
		}
		h.act.add("delete", display(r), "")
		return nil
	case "Mkdir":
		root, r, err := h.check(req.Filepath, "write", true)
		if err != nil {
			return err
		}
		if err := root.CheckDenied(r); err != nil {
			return toSFTP("mkdir", display(r), err)
		}
		if err := h.root.OSRoot().Mkdir(r, 0o755); err != nil {
			return toSFTP("mkdir", display(r), err)
		}
		_ = h.root.ChownNew(r)
		h.act.add("mkdir", display(r), "")
		return nil
	}
	return &sftpError{code: sftp.ErrSSHFxOpUnsupported, msg: "unsupported operation"}
}

// PosixRename (posix-rename@openssh.com) may replace an existing file, never a directory.
func (h *handler) PosixRename(req *sftp.Request) error { return h.rename(req, true) }

func (h *handler) rename(req *sftp.Request, overwrite bool) error {
	root, from, err := h.check(req.Filepath, "write", true)
	if err != nil {
		return err
	}
	_, to, err := h.check(req.Target, "write", true)
	if err != nil {
		return err
	}
	if overwrite {
		if fi, err := h.root.OSRoot().Lstat(to); err == nil {
			if fi.IsDir() {
				return &sftpError{code: sftp.ErrSSHFxFailure, msg: "target is a directory"}
			}
			if err := root.CheckDeniedTree(from); err != nil {
				return toSFTP("rename", display(from), err)
			}
			if err := root.CheckDenied(to); err != nil {
				return toSFTP("rename", display(to), err)
			}
			if err := h.root.OSRoot().Rename(from, to); err != nil {
				return toSFTP("rename", display(from), err)
			}
			h.act.add("rename", display(from), display(to))
			return nil
		}
	}
	// fsops.Rename enforces the denylist on both names and on everything below `from`.
	if err := root.Rename(from, to); err != nil {
		return toSFTP("rename", display(from), err)
	}
	h.act.add("rename", display(from), display(to))
	return nil
}

// setstat applies permission bits (masked to 0777) and timestamps; ownership and size changes
// are refused (use a truncating open to shorten a file). It is always a mutation: never on the root.
func (h *handler) setstat(req *sftp.Request) error {
	fl := req.AttrFlags()
	attrs := req.Attributes()
	if fl.UidGid {
		return denied("changing ownership is not allowed")
	}
	if fl.Size {
		return denied("truncate via setstat is not supported")
	}
	root, r, err := h.check(req.Filepath, "write", true)
	if err != nil {
		return err
	}
	if fl.Permissions {
		if err := root.Chmod(r, attrs.Mode&0o777); err != nil {
			return toSFTP("chmod", display(r), err)
		}
		h.act.add("chmod", display(r), "")
	}
	if fl.Acmodtime {
		if err := root.CheckDenied(r); err != nil {
			return toSFTP("chtimes", display(r), err)
		}
		if fi, err := h.root.OSRoot().Lstat(r); err != nil || fi.Mode()&fs.ModeSymlink != 0 {
			return denied("not a regular file or directory")
		}
		if err := h.root.OSRoot().Chtimes(r, attrs.AccessTime(), attrs.ModTime()); err != nil {
			return toSFTP("chtimes", display(r), err)
		}
		h.act.add("utime", display(r), "")
	}
	return nil
}

// --- listing -----------------------------------------------------------------------------

type listerAt []os.FileInfo

func (l listerAt) ListAt(out []os.FileInfo, off int64) (int, error) {
	if off >= int64(len(l)) {
		return 0, io.EOF
	}
	n := copy(out, l[off:])
	if n < len(out) {
		return n, io.EOF
	}
	return n, nil
}

// namedInfo renames the root entry to "/" for stat replies.
type namedInfo struct {
	os.FileInfo
	name string
}

func (n namedInfo) Name() string { return n.name }

func (h *handler) stat(req *sftp.Request, follow bool) (sftp.ListerAt, error) {
	perms, _, ok := h.c.access()
	if !ok {
		return nil, denied("session expired")
	}
	if !perms["read"] && !perms["write"] {
		return nil, denied("permission denied")
	}
	r, err := rel(req.Filepath)
	if err != nil {
		return nil, toSFTP("stat", req.Filepath, err)
	}
	var fi os.FileInfo
	if follow {
		fi, err = h.root.OSRoot().Stat(r)
	} else {
		fi, err = h.root.OSRoot().Lstat(r)
	}
	if err != nil {
		return nil, toSFTP("stat", display(r), err)
	}
	if r == "." {
		fi = namedInfo{fi, "/"}
	}
	return listerAt{fi}, nil
}

// Filelist handles List and Stat.
func (h *handler) Filelist(req *sftp.Request) (sftp.ListerAt, error) {
	switch req.Method {
	case "Stat":
		return h.stat(req, true)
	case "Readlink":
		return nil, &sftpError{code: sftp.ErrSSHFxOpUnsupported, msg: "readlink is not supported"}
	case "List":
		_, r, err := h.check(req.Filepath, "read", false)
		if err != nil {
			return nil, err
		}
		d, err := h.root.OSRoot().Open(r)
		if err != nil {
			return nil, toSFTP("list", display(r), err)
		}
		defer d.Close()
		var out listerAt
		for len(out) < maxListEntries {
			batch, err := d.ReadDir(1024)
			for _, de := range batch {
				if info, ierr := de.Info(); ierr == nil {
					out = append(out, info)
				}
			}
			if err != nil || len(batch) == 0 {
				if err != nil && !errors.Is(err, io.EOF) {
					return nil, toSFTP("list", display(r), err)
				}
				break
			}
		}
		return out, nil
	}
	return nil, &sftpError{code: sftp.ErrSSHFxOpUnsupported, msg: "unsupported operation"}
}

// Lstat does not follow a final symlink.
func (h *handler) Lstat(req *sftp.Request) (sftp.ListerAt, error) { return h.stat(req, false) }

// --- activity ----------------------------------------------------------------------------

// activity batches mutations into sftp.activity events (≤ 1 s, ≤ 100 actions per event).
type activity struct {
	emit                                 func(string, any)
	workloadID, userID, sessionID, ipStr string

	mu      sync.Mutex
	actions []protocol.SftpAction
	timer   *time.Timer
}

func newActivity(emit func(string, any), workloadID, userID, sessionID, ip string) *activity {
	return &activity{emit: emit, workloadID: workloadID, userID: userID, sessionID: sessionID, ipStr: ip}
}

func trimPath(p string) string { return protocol.TruncateUTF16(p, 1024) }

func (a *activity) add(action, p, to string) {
	a.mu.Lock()
	a.actions = append(a.actions, protocol.SftpAction{Action: action, Path: trimPath(p), To: trimPath(to), TS: time.Now().UnixMilli()})
	if len(a.actions) >= 100 {
		batch := a.take()
		a.mu.Unlock()
		a.send(batch)
		return
	}
	if a.timer == nil {
		a.timer = time.AfterFunc(time.Second, a.flush)
	}
	a.mu.Unlock()
}

// take returns pending actions (caller holds mu).
func (a *activity) take() []protocol.SftpAction {
	batch := a.actions
	a.actions = nil
	if a.timer != nil {
		a.timer.Stop()
		a.timer = nil
	}
	return batch
}

func (a *activity) flush() {
	a.mu.Lock()
	batch := a.take()
	a.mu.Unlock()
	a.send(batch)
}

func (a *activity) send(batch []protocol.SftpAction) {
	if len(batch) == 0 {
		return
	}
	a.emit(protocol.EventSftpActivity, protocol.SftpActivityEvent{WorkloadID: a.workloadID, UserID: a.userID,
		SessionID: a.sessionID, ClientIP: a.ipStr, Actions: batch})
}

func (a *activity) close() { a.flush() }
