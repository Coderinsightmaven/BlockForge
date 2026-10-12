// Package fsops implements the workload filesystem sandbox (fs.* commands).
//
// Every operation goes through an *os.Root opened at <dataRoot>/servers/<id>/data, which makes
// path resolution traversal-resistant at the kernel level (openat-style walk, symlinks may not
// leave the root, absolute symlinks refused). On top of that, CleanPath rejects absolute paths,
// "..", NUL, backslashes, Windows drive letters and device names before anything is touched.
package fsops

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"

	"github.com/blockforge/node-agent/internal/protocol"
)

// Sandbox resolves workload data directories under the agent data root.
type Sandbox struct {
	DataRoot string
	UID, GID int
	// Chown sets ownership of created files/dirs to UID:GID (only possible when running as root).
	Chown bool
	// CopyMaxBytes bounds fs.copy (default DefaultCopyMaxBytes).
	CopyMaxBytes int64
	// FreeSpace reports free bytes on the filesystem holding dir (nil = not checked).
	FreeSpace func(dir string) (int64, error)
}

// DefaultCopyMaxBytes is the fs.copy limit when none is configured.
const DefaultCopyMaxBytes = 10 << 30

// CopyFreeReserve is kept free on the data filesystem by fs.copy.
const CopyFreeReserve = 1 << 30

// NewSandbox builds a sandbox; chown is enabled automatically when the agent runs as root.
func NewSandbox(dataRoot string, uid, gid int) *Sandbox {
	return &Sandbox{DataRoot: dataRoot, UID: uid, GID: gid, Chown: runtime.GOOS != "windows" && os.Geteuid() == 0}
}

// WorkloadBase is <dataRoot>/servers/<id> (agent-owned: spec, state).
func (s *Sandbox) WorkloadBase(id string) string { return filepath.Join(s.DataRoot, "servers", id) }

// DataDir is <dataRoot>/servers/<id>/data, bind-mounted at /data in the container.
func (s *Sandbox) DataDir(id string) string { return filepath.Join(s.WorkloadBase(id), "data") }

// EnsureDataDir creates the workload directories with workload ownership.
func (s *Sandbox) EnsureDataDir(id string) error {
	if !protocol.IsUUID(id) {
		return protocol.Errorf(protocol.CodeValidationFailed, "invalid workload id")
	}
	if err := os.MkdirAll(s.WorkloadBase(id), 0o750); err != nil {
		return err
	}
	dir := s.DataDir(id)
	for _, d := range []string{dir, filepath.Join(dir, ".blockforge")} {
		if err := os.Mkdir(d, 0o750); err != nil && !errors.Is(err, fs.ErrExist) {
			return err
		}
		if s.Chown {
			if err := os.Lchown(d, s.UID, s.GID); err != nil {
				return err
			}
		}
	}
	return nil
}

// Open opens the sandbox root of a workload.
func (s *Sandbox) Open(id string) (*Root, error) {
	if !protocol.IsUUID(id) {
		return nil, protocol.Errorf(protocol.CodeValidationFailed, "invalid workload id")
	}
	r, err := os.OpenRoot(s.DataDir(id))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, protocol.Errorf(protocol.CodeNotFound, "workload data directory does not exist (run workload.ensure first)")
		}
		return nil, protocol.Errorf(protocol.CodeInternal, "open data root: %v", err)
	}
	return &Root{r: r, s: s, info: &rootInfo{dir: s.DataDir(id)}}, nil
}

// Root is an opened workload sandbox.
type Root struct {
	r    *os.Root
	s    *Sandbox
	deny Matcher // nil = no denylist (see WithDenylist)
	info *rootInfo
}

type rootInfo struct {
	dir  string
	once sync.Once
	real string
}

// OSRoot exposes the underlying *os.Root (read-only helpers in other packages).
func (r *Root) OSRoot() *os.Root { return r.r }

// Close releases the root handle.
func (r *Root) Close() error { return r.r.Close() }

// ---------------------------------------------------------------------------
// Path validation

var reDeviceName = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$`)

// CleanPath validates a sandbox-relative path and returns its clean form ("." = data root).
// mutable rejects the data root itself (MutableRelativePath).
func CleanPath(p string, mutable bool) (string, error) {
	if protocol.UTF16Len(p) > 1024 {
		return "", protocol.Errorf(protocol.CodeValidationFailed, "path too long")
	}
	if strings.ContainsRune(p, 0) {
		return "", protocol.Errorf(protocol.CodePathForbidden, "path contains NUL")
	}
	if strings.Contains(p, `\`) {
		return "", protocol.Errorf(protocol.CodePathForbidden, "backslashes are not allowed in paths")
	}
	if strings.HasPrefix(p, "/") {
		return "", protocol.Errorf(protocol.CodePathForbidden, "absolute paths are not allowed")
	}
	if len(p) >= 2 && p[1] == ':' && ((p[0] >= 'a' && p[0] <= 'z') || (p[0] >= 'A' && p[0] <= 'Z')) {
		return "", protocol.Errorf(protocol.CodePathForbidden, "drive letters are not allowed")
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return "", protocol.Errorf(protocol.CodePathForbidden, "'..' is not allowed")
		}
		if reDeviceName.MatchString(seg) {
			return "", protocol.Errorf(protocol.CodePathForbidden, "device names are not allowed")
		}
	}
	clean := path.Clean("./" + p)
	if mutable && clean == "." {
		return "", protocol.Errorf(protocol.CodePathForbidden, "must not target the data root")
	}
	return clean, nil
}

// displayPath renders a clean path for results ("" for the root).
func displayPath(clean string) string {
	if clean == "." {
		return ""
	}
	return clean
}

// ---------------------------------------------------------------------------
// Error mapping

// MapError converts filesystem errors into protocol errors without leaking host paths.
func MapError(op, p string, err error) error {
	if err == nil {
		return nil
	}
	if pe, ok := protocol.AsError(err); ok {
		return pe
	}
	var perr *fs.PathError
	if errors.As(err, &perr) && perr.Err != nil && perr.Err.Error() == "path escapes from parent" {
		return protocol.Errorf(protocol.CodePathForbidden, "%s %q: path escapes the workload data root", op, p)
	}
	var lerr *os.LinkError
	if errors.As(err, &lerr) && lerr.Err != nil && lerr.Err.Error() == "path escapes from parent" {
		return protocol.Errorf(protocol.CodePathForbidden, "%s %q: path escapes the workload data root", op, p)
	}
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return protocol.Errorf(protocol.CodeNotFound, "%s %q: not found", op, p)
	case errors.Is(err, syscall.ENOTEMPTY):
		return protocol.Errorf(protocol.CodeConflict, "%s %q: directory not empty", op, p)
	case errors.Is(err, fs.ErrExist):
		return protocol.Errorf(protocol.CodeAlreadyExists, "%s %q: already exists", op, p)
	case errors.Is(err, fs.ErrPermission):
		return protocol.Errorf(protocol.CodePathForbidden, "%s %q: permission denied", op, p)
	case errors.Is(err, syscall.ENOTDIR):
		return protocol.Errorf(protocol.CodeConflict, "%s %q: a path component is not a directory", op, p)
	case errors.Is(err, syscall.EISDIR):
		return protocol.Errorf(protocol.CodeConflict, "%s %q: is a directory", op, p)
	case errors.Is(err, syscall.EINVAL):
		return protocol.Errorf(protocol.CodeConflict, "%s %q: invalid operation", op, p)
	case errors.Is(err, syscall.ENOSPC):
		return protocol.RetryableErrorf(protocol.CodeQuotaExceeded, "%s %q: no space left on device", op, p)
	case errors.Is(err, syscall.ELOOP):
		return protocol.Errorf(protocol.CodePathForbidden, "%s %q: too many symlinks", op, p)
	}
	return protocol.Errorf(protocol.CodeInternal, "%s %q failed", op, p)
}

// ---------------------------------------------------------------------------
// Helpers shared by the operations

// OpenRegular opens a regular file for reading without blocking on FIFOs and refuses anything
// that is not a regular file (devices, sockets, FIFOs planted by the workload).
func (r *Root) OpenRegular(name string) (*os.File, fs.FileInfo, error) {
	fi, err := r.r.Stat(name)
	if err != nil {
		return nil, nil, MapError("open", name, err)
	}
	if fi.IsDir() {
		return nil, nil, protocol.Errorf(protocol.CodeValidationFailed, "%q is a directory", name)
	}
	if !fi.Mode().IsRegular() {
		return nil, nil, protocol.Errorf(protocol.CodePathForbidden, "%q is not a regular file", name)
	}
	f, err := r.r.OpenFile(name, openReadFlags, 0)
	if err != nil {
		return nil, nil, MapError("open", name, err)
	}
	fi, err = f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		f.Close()
		return nil, nil, protocol.Errorf(protocol.CodePathForbidden, "%q is not a regular file", name)
	}
	return f, fi, nil
}

func (r *Root) chown(name string) error {
	if !r.s.Chown {
		return nil
	}
	return r.r.Lchown(name, r.s.UID, r.s.GID)
}

// MkdirAll creates name and missing parents inside the root, owning new directories by the workload.
func (r *Root) MkdirAll(name string) error {
	if name == "." || name == "" {
		return nil
	}
	cur := ""
	for _, seg := range strings.Split(name, "/") {
		if cur == "" {
			cur = seg
		} else {
			cur = cur + "/" + seg
		}
		fi, err := r.r.Stat(cur)
		if err == nil {
			if !fi.IsDir() {
				return protocol.Errorf(protocol.CodeConflict, "%q exists and is not a directory", cur)
			}
			continue
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return MapError("mkdir", cur, err)
		}
		if err := r.r.Mkdir(cur, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
			return MapError("mkdir", cur, err)
		}
		if err := r.chown(cur); err != nil {
			return MapError("chown", cur, err)
		}
	}
	return nil
}

// requireDir checks that dir exists and is a directory.
func (r *Root) requireDir(dir string) error {
	fi, err := r.r.Stat(dir)
	if err != nil {
		return MapError("stat", dir, err)
	}
	if !fi.IsDir() {
		return protocol.Errorf(protocol.CodeConflict, "%q is not a directory", dir)
	}
	return nil
}

// TempFile streams content into a temporary sibling of the final path and atomically renames it.
type TempFile struct {
	r     *Root
	f     *os.File
	tmp   string
	final string
	mode  fs.FileMode
	h     hash.Hash
	n     int64
	done  bool
}

// CreateTemp prepares an atomic write of final (parents must exist). mode applies to the new file.
func (r *Root) CreateTemp(final string, mode fs.FileMode) (*TempFile, error) {
	var rnd [8]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		return nil, err
	}
	dir, base := path.Split(final)
	tmp := path.Join(dir, fmt.Sprintf(".%s.bf-tmp-%s", base, hex.EncodeToString(rnd[:])))
	f, err := r.r.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return nil, MapError("create", final, err)
	}
	return &TempFile{r: r, f: f, tmp: tmp, final: final, mode: mode, h: sha256.New()}, nil
}

// Write implements io.Writer, hashing as it goes.
func (t *TempFile) Write(b []byte) (int, error) {
	n, err := t.f.Write(b)
	t.h.Write(b[:n])
	t.n += int64(n)
	return n, err
}

// Size is the number of bytes written so far.
func (t *TempFile) Size() int64 { return t.n }

// Sha256 is the hex digest of the bytes written so far.
func (t *TempFile) Sha256() string { return hex.EncodeToString(t.h.Sum(nil)) }

// Abort removes the temporary file.
func (t *TempFile) Abort() {
	if t.done {
		return
	}
	t.done = true
	t.f.Close()
	_ = t.r.r.Remove(t.tmp)
}

// Commit fsyncs, fixes mode/ownership, renames over the final path and fsyncs the directory.
func (t *TempFile) Commit() (string, int64, error) {
	if t.done {
		return "", 0, errors.New("temp file already finished")
	}
	fail := func(op string, err error) (string, int64, error) {
		t.Abort()
		return "", 0, MapError(op, t.final, err)
	}
	if err := t.f.Sync(); err != nil {
		return fail("fsync", err)
	}
	if err := t.f.Close(); err != nil {
		t.done = true
		_ = t.r.r.Remove(t.tmp)
		return "", 0, MapError("close", t.final, err)
	}
	if runtime.GOOS != "windows" {
		if err := t.r.r.Chmod(t.tmp, t.mode); err != nil {
			return fail("chmod", err)
		}
	}
	if err := t.r.chown(t.tmp); err != nil {
		return fail("chown", err)
	}
	if fi, err := t.r.r.Lstat(t.final); err == nil && fi.IsDir() {
		return fail("rename", syscall.EISDIR)
	}
	if err := t.r.r.Rename(t.tmp, t.final); err != nil {
		return fail("rename", err)
	}
	t.done = true
	t.r.syncDir(path.Dir(t.final))
	return t.Sha256(), t.n, nil
}

func (r *Root) syncDir(dir string) {
	if d, err := r.r.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
}

// hashFile returns the sha256 of a regular file inside the root.
func (r *Root) hashFile(name string) (string, int64, error) {
	f, _, err := r.OpenRegular(name)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, MapError("read", name, err)
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

// ChownNew gives a freshly created entry to the workload user (no-op unless the agent runs as root).
func (r *Root) ChownNew(name string) error { return r.chown(name) }
