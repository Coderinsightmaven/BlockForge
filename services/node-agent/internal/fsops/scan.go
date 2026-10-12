package fsops

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"hash"
	"io"
	"io/fs"
	"math"
	"os"
	"time"

	"github.com/blockforge/node-agent/internal/jarread"
	"github.com/blockforge/node-agent/internal/protocol"
)

// Extension scans (fs.hash, jar.readEntries; agent-protocol.md §6). Both are read-only: files are
// opened O_RDONLY through OpenNoFollow and nothing is created, renamed or written. Per-file failures
// are reported per entry; the only command-level errors are a missing data dir (Sandbox.Open) and
// cancellation.
//
// Consistency: a file's identity (fileID: device, inode, size, mtime and — on Linux/BSD — the inode
// change time) is taken once it is open and checked again after every pass over it (the whole-file
// hash, the jar parse). Any write, truncate or utimes in between changes ctime, which an unprivileged
// workload cannot set back, so the digests and the parsed entries always describe the same content
// or the file is reported as IO_ERROR.

// scanFrameLimit bounds the encoded jar.readEntries result below the frame size the executor accepts.
var scanFrameLimit = protocol.MaxFrameBytes - 64*1024

// scanHook, if set, runs at stages of a scan ("opened": open, identity taken and size checked;
// "hashed": jar hashed, before it is parsed) — tests change the file there.
var scanHook func(stage, path string)

func hook(stage, path string) {
	if scanHook != nil {
		scanHook(stage, path)
	}
}

const hashBufferBytes = 1 << 20

// ctimeSettle: a file whose last change is younger than this is re-examined after a short wait (see
// fileID.settleWait).
const ctimeSettle = 20 * time.Millisecond

var errChangedWhileRead = errors.New("file changed while it was read")

// scanFile is a requested path opened for a scan.
type scanFile struct {
	f  *os.File
	fi fs.FileInfo // fstat at the time id was taken (sizeBytes, mtime)
	id fileID
}

// scanOpen applies the path rules, the denylist and the no-follow open to a requested path; it
// returns a per-file error code on failure. The denylist has the semantics of every other fs command
// (requested path, symlinks it passes through, resolved location) and a symlink resolving outside the
// sandbox is a sandbox violation: both PATH_FORBIDDEN, as for fs.read. Any other symlink is refused
// by the open (NOT_REGULAR). After the open the file's real location is checked too (Linux; a parent
// directory moved meanwhile) and its identity is taken.
func (r *Root) scanOpen(p string) (*scanFile, string) {
	clean, err := CleanPath(p, false)
	if err != nil {
		return nil, protocol.ScanPathForbidden
	}
	// Other resolution failures (link loops, I/O) are left to the no-follow open.
	if r.deny != nil {
		_, err = r.checkDeny(clean)
	} else {
		_, _, err = r.resolve(clean)
	}
	if isDenylistError(err) || isEscape(err) {
		return nil, protocol.ScanPathForbidden
	}
	f, _, err := r.OpenNoFollow(clean)
	if err != nil {
		return nil, scanOpenCode(err)
	}
	if err := r.VerifyOpen(f, clean); err != nil {
		f.Close()
		return nil, protocol.ScanPathForbidden
	}
	fi, id, err := settledID(f)
	if err != nil {
		f.Close()
		return nil, protocol.ScanIOError
	}
	return &scanFile{f: f, fi: fi, id: id}, ""
}

// settledID takes the identity of an open file, first waiting out a change younger than ctimeSettle
// (a file changing continuously fails with errChangedWhileRead).
func settledID(f *os.File) (fs.FileInfo, fileID, error) {
	for attempt := 0; ; attempt++ {
		fi, err := f.Stat()
		if err != nil {
			return nil, fileID{}, err
		}
		id := idOf(fi)
		wait := id.settleWait(time.Now())
		if wait <= 0 {
			return fi, id, nil
		}
		if attempt == 3 {
			return nil, fileID{}, errChangedWhileRead
		}
		time.Sleep(wait)
	}
}

// unchanged re-stats an open file: a different identity means it changed since the identity was taken.
func unchanged(f *os.File, before fileID) error {
	now, err := f.Stat()
	if err != nil {
		return err
	}
	if !idOf(now).same(before) {
		return errChangedWhileRead
	}
	return nil
}

func isDenylistError(err error) bool {
	pe, ok := protocol.AsError(err)
	if !ok {
		return false
	}
	d, _ := pe.Details.(map[string]any)
	return d["reason"] == "denylist"
}

func scanOpenCode(err error) string {
	switch {
	case errors.Is(err, ErrNotRegular):
		return protocol.ScanNotRegular
	case errors.Is(err, fs.ErrNotExist):
		return protocol.ScanNotFound
	}
	// ErrChanged (swapped while being opened), permission and device errors: the file could not be
	// read reliably; a retry may succeed.
	return protocol.ScanIOError
}

func epochMs(fi fs.FileInfo) int64 { return max(0, fi.ModTime().UnixMilli()) }

// ctxReader stops a long read when the command is cancelled.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// digestFile reads exactly the identity's size of sf into the named hashes (one pass) and checks that
// the file did not change meanwhile. n is the number of bytes read.
func digestFile(ctx context.Context, sf *scanFile, algorithms []string, buf []byte) (map[string]string, int64, error) {
	hs := make(map[string]hash.Hash, len(algorithms))
	ws := make([]io.Writer, 0, len(algorithms))
	for _, a := range algorithms {
		var h hash.Hash
		switch a {
		case "sha1":
			h = sha1.New()
		case "sha256":
			h = sha256.New()
		case "sha512":
			h = sha512.New()
		default:
			return nil, 0, protocol.Errorf(protocol.CodeValidationFailed, "unknown algorithm %q", a)
		}
		hs[a] = h
		ws = append(ws, h)
	}
	size := sf.fi.Size()
	n, err := io.CopyBuffer(io.MultiWriter(ws...), io.LimitReader(ctxReader{ctx, sf.f}, size+1), buf)
	if err != nil {
		return nil, n, err
	}
	if n != size {
		return nil, n, errChangedWhileRead
	}
	if err := unchanged(sf.f, sf.id); err != nil {
		return nil, n, err
	}
	out := make(map[string]string, len(hs))
	for a, h := range hs {
		out[a] = hex.EncodeToString(h.Sum(nil))
	}
	return out, n, nil
}

func isCtxErr(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

// Hash implements fs.hash: per-file digests in request order, one read pass per file.
func (r *Root) Hash(ctx context.Context, p *protocol.FsHashPayload) (*protocol.FsHashResult, error) {
	res := &protocol.FsHashResult{Files: make([]protocol.FsHashEntry, 0, len(p.Paths))}
	fail := func(path, code string) {
		res.Files = append(res.Files, protocol.FsHashEntry{Path: path, Error: code})
	}
	buf := make([]byte, hashBufferBytes)
	var hashed int64
	exhausted := false
	for i, path := range p.Paths {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if exhausted {
			fail(path, protocol.ScanBudgetExceeded)
			continue
		}
		sf, code := r.scanOpen(path)
		if code != "" {
			fail(path, code)
			continue
		}
		size := sf.fi.Size()
		switch {
		case size > p.MaxBytesPerFile:
			sf.f.Close()
			fail(path, protocol.ScanTooLarge)
			continue
		case i > 0 && size > p.MaxTotalBytes-hashed: // the first file is always attempted
			sf.f.Close()
			exhausted = true
			fail(path, protocol.ScanBudgetExceeded)
			continue
		}
		hook("opened", path)
		sums, n, err := digestFile(ctx, sf, p.Algorithms, buf)
		sf.f.Close()
		hashed += n
		if err != nil {
			if isCtxErr(err) {
				return nil, err
			}
			fail(path, protocol.ScanIOError)
			continue
		}
		res.Files = append(res.Files, protocol.FsHashEntry{OK: true, Path: path, SizeBytes: size, Mtime: epochMs(sf.fi),
			Sha1: sums["sha1"], Sha256: sums["sha256"], Sha512: sums["sha512"]})
	}
	return res, nil
}

// errReadBudget: jar.readEntries' maxReadBytes would be exceeded.
var errReadBudget = errors.New("command read budget exhausted")

// readBudget counts the bytes a command reads from disk.
type readBudget struct {
	used, max int64
}

// meteredReaderAt counts reads into a budget and refuses to read past limit (total bytes used).
type meteredReaderAt struct {
	ra    io.ReaderAt
	b     *readBudget
	limit int64
}

func (m *meteredReaderAt) ReadAt(p []byte, off int64) (int, error) {
	room := m.limit - m.b.used
	if room <= 0 && len(p) > 0 {
		return 0, errReadBudget
	}
	short := int64(len(p)) > room
	if short {
		p = p[:room]
	}
	n, err := m.ra.ReadAt(p, off)
	m.b.used += int64(n)
	if err == nil && short {
		err = errReadBudget
	}
	return n, err
}

// ReadJarEntries implements jar.readEntries.
func (r *Root) ReadJarEntries(ctx context.Context, p *protocol.JarReadEntriesPayload) (*protocol.JarReadEntriesResult, error) {
	res := &protocol.JarReadEntriesResult{Jars: make([]protocol.JarReadResult, 0, len(p.Paths))}
	// The result must also fit in one frame (paths and entry names count too): start from the size of
	// an all-BUDGET_EXCEEDED answer and account for every successful jar's extra bytes.
	frame := int64(len(`{"jars":[]}`))
	for _, path := range p.Paths {
		frame += failureSize(path) + 1
	}
	var content int64
	reads := &readBudget{max: p.MaxReadBytes}
	exhausted := false
	buf := make([]byte, hashBufferBytes)
	for i, path := range p.Paths {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if exhausted {
			res.Jars = append(res.Jars, protocol.JarReadResult{Path: path, Error: protocol.ScanBudgetExceeded})
			continue
		}
		jr, err := r.readJar(ctx, path, p, i == 0, reads, buf)
		if err != nil {
			return nil, err
		}
		if !jr.OK && jr.Error == protocol.ScanBudgetExceeded {
			exhausted = true
		}
		if jr.OK {
			var c int64
			for _, e := range jr.Entries {
				c += int64(protocol.JSONStringLen(e.Content))
			}
			b, err := protocol.Marshal(jr)
			if err != nil {
				return nil, err
			}
			extra := int64(len(b)) - failureSize(path)
			// The first jar is always returned, so a retry of the rest always makes progress.
			if i > 0 && (c > int64(p.MaxTotalBytes)-content || extra > int64(scanFrameLimit)-frame) {
				exhausted = true
				res.Jars = append(res.Jars, protocol.JarReadResult{Path: path, Error: protocol.ScanBudgetExceeded})
				continue
			}
			content += c
			frame += extra
		}
		res.Jars = append(res.Jars, jr)
	}
	return res, nil
}

func failureSize(path string) int64 {
	b, _ := protocol.Marshal(protocol.JarReadResult{Path: path, Error: protocol.ScanBudgetExceeded})
	return int64(len(b))
}

// readJar reads one jar; the error is non-nil only when the command is cancelled. Every byte read
// counts against reads; except for the first jar (always processed) the jar is BUDGET_EXCEEDED
// when its whole-file hash would not fit into the remaining read budget, or when its parse runs out.
func (r *Root) readJar(ctx context.Context, path string, p *protocol.JarReadEntriesPayload, first bool, reads *readBudget, buf []byte) (protocol.JarReadResult, error) {
	fail := func(code string) (protocol.JarReadResult, error) {
		return protocol.JarReadResult{Path: path, Error: code}, nil
	}
	sf, code := r.scanOpen(path)
	if code != "" {
		return fail(code)
	}
	defer sf.f.Close()
	size := sf.fi.Size()
	if size > p.MaxJarBytes {
		return fail(protocol.ScanTooLarge)
	}
	limit := int64(math.MaxInt64)
	if !first {
		limit = reads.max
		if len(p.Hash) > 0 && size > reads.max-reads.used {
			return fail(protocol.ScanBudgetExceeded)
		}
	}
	hook("opened", path)
	out := protocol.JarReadResult{OK: true, Path: path, SizeBytes: size, Mtime: epochMs(sf.fi)}
	if len(p.Hash) > 0 {
		sums, n, err := digestFile(ctx, sf, p.Hash, buf)
		reads.used += n
		if err != nil {
			if isCtxErr(err) {
				return protocol.JarReadResult{}, err
			}
			return fail(protocol.ScanIOError)
		}
		out.Sha1, out.Sha512 = sums["sha1"], sums["sha512"]
	}
	hook("hashed", path)
	zr, err := jarread.Read(ctx, &meteredReaderAt{ra: sf.f, b: reads, limit: limit}, size, p.Entries, int(p.MaxEntryBytes), jarread.DefaultLimits)
	if isCtxErr(err) {
		return protocol.JarReadResult{}, err
	}
	if errors.Is(err, errReadBudget) {
		return fail(protocol.ScanBudgetExceeded)
	}
	// A jar rewritten since it was opened (and hashed) is IO_ERROR (retry), whatever the parser concluded.
	if uerr := unchanged(sf.f, sf.id); uerr != nil {
		return fail(protocol.ScanIOError)
	}
	switch {
	case err == nil:
	case errors.Is(err, jarread.ErrTooLarge):
		return fail(protocol.ScanTooLarge)
	case errors.Is(err, jarread.ErrAmbiguous):
		return fail(protocol.ScanAmbiguousEntry)
	case errors.Is(err, jarread.ErrNotZip):
		return fail(protocol.ScanNotAZip)
	default: // *jarread.IOError: the device failed
		return fail(protocol.ScanIOError)
	}
	out.Entries = make([]protocol.JarEntryContent, 0, len(zr.Entries))
	for _, e := range zr.Entries {
		text, truncated := jarread.Text(e.Data, e.Complete, int(p.MaxEntryBytes))
		out.Entries = append(out.Entries, protocol.JarEntryContent{Name: e.Name, Content: text, Size: int64(e.Size), Truncated: truncated})
	}
	out.Missing = zr.Missing
	return out, nil
}
