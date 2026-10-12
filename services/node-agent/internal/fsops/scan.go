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
	"os"

	"github.com/blockforge/node-agent/internal/jarread"
	"github.com/blockforge/node-agent/internal/protocol"
)

// Extension scans (fs.hash, jar.readEntries; agent-protocol.md §6). Both are read-only: files are
// opened O_RDONLY through OpenNoFollow and nothing is created, renamed or written. Per-file failures
// are reported per entry; the only command-level errors are a missing data dir (Sandbox.Open) and
// cancellation.

// scanFrameLimit bounds the encoded jar.readEntries result below the frame size the executor accepts.
var scanFrameLimit = protocol.MaxFrameBytes - 64*1024

// afterJarOpen, if set, runs once a jar is open and its size checked (tests change it meanwhile).
var afterJarOpen func(path string)

const hashBufferBytes = 1 << 20

// scanOpen applies the path rules, the denylist and the no-follow open to a requested path; it
// returns a per-file error code on failure. The denylist has the semantics of every other fs command
// (requested path, symlinks it passes through, resolved location: PATH_FORBIDDEN) even though the
// open then refuses any symlink (NOT_REGULAR); after the open the file's real location is checked
// too (Linux; a parent directory moved meanwhile).
func (r *Root) scanOpen(p string) (*os.File, fs.FileInfo, string) {
	clean, err := CleanPath(p, false)
	if err != nil {
		return nil, nil, protocol.ScanPathForbidden
	}
	if r.deny != nil {
		// Other resolution failures (absolute or escaping links, I/O) are left to the no-follow open.
		if _, err := r.checkDeny(clean); err != nil && isDenylistError(err) {
			return nil, nil, protocol.ScanPathForbidden
		}
	}
	f, fi, err := r.OpenNoFollow(clean)
	if err != nil {
		return nil, nil, scanOpenCode(err)
	}
	if err := r.VerifyOpen(f, clean); err != nil {
		f.Close()
		return nil, nil, protocol.ScanPathForbidden
	}
	return f, fi, ""
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

var errChangedWhileRead = errors.New("file changed while it was read")

// digestFile reads exactly fi.Size() bytes of f into the named hashes (one pass) and checks that the
// file neither grew, shrank nor was modified meanwhile. n is the number of bytes read.
func digestFile(ctx context.Context, f *os.File, fi fs.FileInfo, algorithms []string, buf []byte) (map[string]string, int64, error) {
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
	size := fi.Size()
	n, err := io.CopyBuffer(io.MultiWriter(ws...), io.LimitReader(ctxReader{ctx, f}, size+1), buf)
	if err != nil {
		return nil, n, err
	}
	if n != size {
		return nil, n, errChangedWhileRead
	}
	if err := unchanged(f, fi); err != nil {
		return nil, n, err
	}
	out := make(map[string]string, len(hs))
	for a, h := range hs {
		out[a] = hex.EncodeToString(h.Sum(nil))
	}
	return out, n, nil
}

// unchanged re-stats an open file: a different size or modification time means it changed while
// it was being read.
func unchanged(f *os.File, before fs.FileInfo) error {
	now, err := f.Stat()
	if err != nil {
		return err
	}
	if now.Size() != before.Size() || !now.ModTime().Equal(before.ModTime()) {
		return errChangedWhileRead
	}
	return nil
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
		f, fi, code := r.scanOpen(path)
		if code != "" {
			fail(path, code)
			continue
		}
		size := fi.Size()
		switch {
		case size > p.MaxBytesPerFile:
			f.Close()
			fail(path, protocol.ScanTooLarge)
			continue
		case i > 0 && size > p.MaxTotalBytes-hashed: // the first file is always attempted
			f.Close()
			exhausted = true
			fail(path, protocol.ScanBudgetExceeded)
			continue
		}
		sums, n, err := digestFile(ctx, f, fi, p.Algorithms, buf)
		f.Close()
		hashed += n
		if err != nil {
			if isCtxErr(err) {
				return nil, err
			}
			fail(path, protocol.ScanIOError)
			continue
		}
		res.Files = append(res.Files, protocol.FsHashEntry{OK: true, Path: path, SizeBytes: size, Mtime: epochMs(fi),
			Sha1: sums["sha1"], Sha256: sums["sha256"], Sha512: sums["sha512"]})
	}
	return res, nil
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
		jr, err := r.readJar(ctx, path, p, buf)
		if err != nil {
			return nil, err
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

// readJar reads one jar; the error is non-nil only when the command is cancelled.
func (r *Root) readJar(ctx context.Context, path string, p *protocol.JarReadEntriesPayload, buf []byte) (protocol.JarReadResult, error) {
	fail := func(code string) (protocol.JarReadResult, error) {
		return protocol.JarReadResult{Path: path, Error: code}, nil
	}
	f, fi, code := r.scanOpen(path)
	if code != "" {
		return fail(code)
	}
	defer f.Close()
	if fi.Size() > p.MaxJarBytes {
		return fail(protocol.ScanTooLarge)
	}
	if afterJarOpen != nil {
		afterJarOpen(path)
	}
	out := protocol.JarReadResult{OK: true, Path: path, SizeBytes: fi.Size(), Mtime: epochMs(fi)}
	if len(p.Hash) > 0 {
		sums, _, err := digestFile(ctx, f, fi, p.Hash, buf)
		if err != nil {
			if isCtxErr(err) {
				return protocol.JarReadResult{}, err
			}
			return fail(protocol.ScanIOError)
		}
		out.Sha1, out.Sha512 = sums["sha1"], sums["sha512"]
	}
	zr, err := jarread.Read(ctx, f, fi.Size(), p.Entries, int(p.MaxEntryBytes), jarread.DefaultLimits)
	if isCtxErr(err) {
		return protocol.JarReadResult{}, err
	}
	// A jar rewritten while it was parsed is IO_ERROR (retry), whatever the parser concluded.
	if uerr := unchanged(f, fi); uerr != nil {
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
