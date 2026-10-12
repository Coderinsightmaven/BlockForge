package fsops

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"strings"
	"time"

	"github.com/blockforge/node-agent/internal/protocol"
)

// Limits for the Phase 3 file operations.
const (
	maxCopyAttempts = 100
	MaxFindWalk     = 500_000
)

var multiExt = []string{".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tar.lz4"}

// splitExt returns name and extension, treating common double extensions and dot-files sensibly.
func splitExt(base string) (string, string) {
	lower := strings.ToLower(base)
	for _, e := range multiExt {
		if strings.HasSuffix(lower, e) && len(base) > len(e) {
			return base[:len(base)-len(e)], base[len(base)-len(e):]
		}
	}
	ext := path.Ext(base)
	if ext == base || ext == "" { // ".bashrc" or "README"
		return base, ""
	}
	return strings.TrimSuffix(base, ext), ext
}

// copyName is "name copy.ext" for n == 1 and "name copy n.ext" afterwards.
func copyName(base string, n int, isDir bool) string {
	name, ext := base, ""
	if !isDir {
		name, ext = splitExt(base)
	}
	if n == 1 {
		return name + " copy" + ext
	}
	return fmt.Sprintf("%s copy %d%s", name, n, ext)
}

// Copy implements fs.copy: duplicates a file or directory next to itself. Symlinks and special files
// inside a copied directory are skipped (never followed); the copy is removed if anything fails.
func (r *Root) Copy(p string) (string, error) {
	src, err := CleanPath(p, true)
	if err != nil {
		return "", err
	}
	fi, err := r.r.Lstat(src)
	if err != nil {
		return "", MapError("copy", p, err)
	}
	// Copying a tree would expose denied entries under a new, allowed name.
	if err := r.checkDenyTree(src); err != nil {
		return "", err
	}
	if !fi.IsDir() && !fi.Mode().IsRegular() {
		return "", protocol.Errorf(protocol.CodePathForbidden, "%q is not a regular file or directory", p)
	}
	total, err := r.treeSize(src, fi)
	if err != nil {
		return "", err
	}
	budget := r.copyBudget()
	if total > budget {
		return "", protocol.Errorf(protocol.CodeQuotaExceeded, "copy needs %d bytes (limit %d)", total, budget).
			WithDetails(map[string]any{"bytes": total, "limit": budget})
	}
	cp := &copier{r: r, remaining: budget}
	dir, base := path.Split(src)
	var dst string
	for n := 1; n <= maxCopyAttempts; n++ {
		cand := path.Join(dir, copyName(base, n, fi.IsDir()))
		if _, err := r.r.Lstat(cand); errors.Is(err, fs.ErrNotExist) {
			dst = cand
			break
		} else if err != nil {
			return "", MapError("copy", cand, err)
		}
	}
	if dst == "" {
		return "", protocol.Errorf(protocol.CodeConflict, "too many copies of %q", p)
	}
	if _, err := r.checkDeny(dst); err != nil {
		return "", err
	}
	if !fi.IsDir() {
		if err := cp.copyFile(src, dst, fi.Mode().Perm()); err != nil {
			return "", err
		}
		return dst, nil
	}
	if err := r.r.Mkdir(dst, fi.Mode().Perm()|0o700); err != nil {
		return "", MapError("copy", dst, err)
	}
	_ = r.chown(dst)
	// Entries are opened relative to their already-opened parent without following symlinks, so a
	// symlink swapped in after the deny check is skipped, never copied through.
	_, walkErr := r.WalkTree(context.Background(), src, WalkOptions{MaxEntries: MaxWalkEntries}, func(e *TreeEntry) error {
		if e.denied(r.deny) {
			return denyErr(displayPath(e.Rel))
		}
		target := path.Join(dst, strings.TrimPrefix(e.Rel, src+"/"))
		switch {
		case e.Mode.IsDir():
			if err := r.r.Mkdir(target, e.Info.Mode().Perm()|0o700); err != nil {
				return MapError("copy", target, err)
			}
			_ = r.chown(target)
		case e.Mode.IsRegular():
			in, fi, err := e.Open()
			if err != nil {
				if Skipped(err) {
					return nil
				}
				return err
			}
			defer in.Close() // per entry: this callback returns right after the copy
			return cp.copyFrom(in, target, fi.Mode().Perm())
		}
		return nil // symlinks, sockets, FIFOs: skipped
	})
	if walkErr != nil {
		_ = r.r.RemoveAll(dst)
		if pe, ok := protocol.AsError(walkErr); ok {
			return "", pe
		}
		return "", MapError("copy", p, walkErr)
	}
	return dst, nil
}

// treeSize sums the regular files fs.copy would copy (symlinks/special files are skipped).
func (r *Root) treeSize(src string, fi fs.FileInfo) (int64, error) {
	if !fi.IsDir() {
		return fi.Size(), nil
	}
	var total int64
	seen := 0
	err := fs.WalkDir(r.r.FS(), src, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		seen++
		if seen > MaxWalkEntries {
			return protocol.Errorf(protocol.CodeQuotaExceeded, "directory has more than %d entries", MaxWalkEntries)
		}
		if d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total, err
}

// copyBudget is the configured fs.copy limit, further bounded by free space minus a reserve.
func (r *Root) copyBudget() int64 {
	limit := r.s.CopyMaxBytes
	if limit <= 0 {
		limit = DefaultCopyMaxBytes
	}
	if r.s.FreeSpace != nil {
		if free, err := r.s.FreeSpace(r.info.dir); err == nil {
			avail := free - CopyFreeReserve
			if avail < 0 {
				avail = 0
			}
			if avail < limit {
				limit = avail
			}
		}
	}
	return limit
}

// copier enforces the byte budget on the bytes actually streamed (files may grow during a copy).
type copier struct {
	r         *Root
	remaining int64
}

func (c *copier) copyFile(src, dst string, mode fs.FileMode) error {
	in, _, err := c.r.OpenForRead(src)
	if err != nil {
		return err
	}
	defer in.Close()
	return c.copyFrom(in, dst, mode)
}

func (c *copier) copyFrom(in *os.File, dst string, mode fs.FileMode) error {
	r := c.r
	tf, err := r.CreateTemp(dst, mode)
	if err != nil {
		return err
	}
	n, err := io.Copy(tf, io.LimitReader(in, c.remaining+1))
	if err != nil {
		tf.Abort()
		return MapError("copy", dst, err)
	}
	if n > c.remaining {
		tf.Abort()
		return protocol.Errorf(protocol.CodeQuotaExceeded, "copy exceeds its byte limit")
	}
	c.remaining -= n
	if _, err := r.r.Lstat(dst); err == nil {
		tf.Abort()
		return protocol.Errorf(protocol.CodeAlreadyExists, "%q already exists", dst)
	}
	_, _, err = tf.Commit()
	return err
}

// Chmod implements fs.chmod: permission bits only, never on symlinks or special files.
func (r *Root) Chmod(p string, mode uint32) error {
	if mode > 0o777 {
		return protocol.Errorf(protocol.CodeValidationFailed, "mode must be within 0–0777")
	}
	name, err := CleanPath(p, true)
	if err != nil {
		return err
	}
	if _, err := r.checkDeny(name); err != nil {
		return err
	}
	li, err := r.r.Lstat(name)
	if err != nil {
		return MapError("chmod", p, err)
	}
	if li.Mode()&fs.ModeSymlink != 0 {
		return protocol.Errorf(protocol.CodePathForbidden, "%q is a symlink", p)
	}
	if !li.IsDir() && !li.Mode().IsRegular() {
		return protocol.Errorf(protocol.CodePathForbidden, "%q is not a regular file or directory", p)
	}
	// fchmod on an fd opened through the root: no path re-resolution between check and change.
	f, err := r.r.OpenFile(name, openReadFlags, 0)
	if err != nil {
		return MapError("chmod", p, err)
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !os.SameFile(li, fi) {
		return protocol.Errorf(protocol.CodeConflict, "%q changed while being modified", p)
	}
	if err := f.Chmod(fs.FileMode(mode)); err != nil {
		return MapError("chmod", p, err)
	}
	return nil
}

// FindResult is the fs.find result.
type FindResult struct {
	Matches   []protocol.FileEntry `json:"matches"`
	Truncated bool                 `json:"truncated"`
}

// Find implements fs.find: case-insensitive substring match on names below p. Symlinked
// directories are not descended; the walk is bounded by MaxFindWalk entries.
func (r *Root) Find(p, query string, maxResults int) (*FindResult, error) {
	base, err := CleanPath(p, false)
	if err != nil {
		return nil, err
	}
	if fi, err := r.r.Stat(base); err != nil {
		return nil, MapError("find", p, err)
	} else if !fi.IsDir() {
		return nil, protocol.Errorf(protocol.CodeValidationFailed, "%q is not a directory", p)
	}
	q := strings.ToLower(query)
	res := &FindResult{Matches: []protocol.FileEntry{}}
	seen := 0
	err = fs.WalkDir(r.r.FS(), base, func(fp string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable subtree: skip
		}
		if fp == base {
			return nil
		}
		seen++
		if seen > MaxFindWalk {
			res.Truncated = true
			return fs.SkipAll
		}
		if !strings.Contains(strings.ToLower(d.Name()), q) {
			return nil
		}
		if len(res.Matches) >= maxResults {
			res.Truncated = true
			return fs.SkipAll
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		res.Matches = append(res.Matches, entryFor(d.Name(), fp, info))
		return nil
	})
	if err != nil {
		return nil, MapError("find", p, err)
	}
	return res, nil
}

// CompressResult is the fs.compress result.
type CompressResult struct {
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	Entries int64  `json:"entries"`
}

type archiveWriter interface {
	dir(name string, info fs.FileInfo) error
	file(name string, info fs.FileInfo, src io.Reader) error
	close() error
}

type tarGzWriter struct {
	gz *gzip.Writer
	tw *tar.Writer
}

func (w *tarGzWriter) hdr(name string, info fs.FileInfo, typ byte, size int64) *tar.Header {
	return &tar.Header{Name: name, Typeflag: typ, Size: size, Mode: int64(info.Mode().Perm()),
		ModTime: info.ModTime().Truncate(time.Second), Format: tar.FormatPAX}
}
func (w *tarGzWriter) dir(name string, info fs.FileInfo) error {
	return w.tw.WriteHeader(w.hdr(name+"/", info, tar.TypeDir, 0))
}
func (w *tarGzWriter) file(name string, info fs.FileInfo, src io.Reader) error {
	if err := w.tw.WriteHeader(w.hdr(name, info, tar.TypeReg, info.Size())); err != nil {
		return err
	}
	_, err := io.CopyN(w.tw, src, info.Size())
	return err
}
func (w *tarGzWriter) close() error {
	if err := w.tw.Close(); err != nil {
		return err
	}
	return w.gz.Close()
}

type zipWriter struct{ zw *zip.Writer }

func (w *zipWriter) header(name string, info fs.FileInfo) *zip.FileHeader {
	h := &zip.FileHeader{Name: name, Method: zip.Deflate, Modified: info.ModTime()}
	h.SetMode(info.Mode().Perm() | (info.Mode() & fs.ModeDir))
	return h
}
func (w *zipWriter) dir(name string, info fs.FileInfo) error {
	h := w.header(name+"/", info)
	h.Method = zip.Store
	_, err := w.zw.CreateHeader(h)
	return err
}
func (w *zipWriter) file(name string, info fs.FileInfo, src io.Reader) error {
	dst, err := w.zw.CreateHeader(w.header(name, info))
	if err != nil {
		return err
	}
	_, err = io.CopyN(dst, src, info.Size())
	return err
}
func (w *zipWriter) close() error { return w.zw.Close() }

// Compress implements fs.compress. Entry names are relative to root; symlinks and special files are
// skipped (never followed); the uncompressed input is bounded by maxTotalBytes; the archive is
// written to a temp file and published only if destPath still does not exist.
func (r *Root) Compress(p protocol.FsCompressPayload, now time.Time) (*CompressResult, error) {
	root, err := CleanPath(p.Root, false)
	if err != nil {
		return nil, err
	}
	if fi, err := r.r.Stat(root); err != nil {
		return nil, MapError("compress", p.Root, err)
	} else if !fi.IsDir() {
		return nil, protocol.Errorf(protocol.CodeValidationFailed, "%q is not a directory", p.Root)
	}
	ext := ".tar.gz"
	if p.Format == "zip" {
		ext = ".zip"
	}
	destRel := p.DestPath
	if destRel == "" {
		destRel = path.Join(displayPath(root), "archive-"+now.UTC().Format("2006-01-02T150405Z")+ext)
	}
	dest, err := CleanPath(destRel, true)
	if err != nil {
		return nil, err
	}
	if _, err := r.r.Lstat(dest); err == nil {
		return nil, protocol.Errorf(protocol.CodeAlreadyExists, "%q already exists", destRel)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil, MapError("compress", destRel, err)
	}
	if err := r.requireDir(path.Dir(dest)); err != nil {
		return nil, err
	}
	if _, err := r.checkDeny(dest); err != nil {
		return nil, err
	}
	inputs := make([]string, 0, len(p.Paths))
	for _, ip := range p.Paths {
		rel, err := CleanPath(ip, true)
		if err != nil {
			return nil, err
		}
		full := path.Join(root, rel)
		if root == "." {
			full = rel
		}
		if _, err := r.r.Lstat(full); err != nil {
			return nil, MapError("compress", ip, err)
		}
		// Archiving would leak denied entries.
		if err := r.checkDenyTree(full); err != nil {
			return nil, err
		}
		inputs = append(inputs, full)
	}
	tf, err := r.CreateTemp(dest, 0o644)
	if err != nil {
		return nil, err
	}
	var aw archiveWriter
	if p.Format == "zip" {
		aw = &zipWriter{zw: zip.NewWriter(tf)}
	} else {
		gz := gzip.NewWriter(tf)
		aw = &tarGzWriter{gz: gz, tw: tar.NewWriter(gz)}
	}
	var total, entries int64
	nameOf := func(fp string) string {
		if root == "." {
			return fp
		}
		return strings.TrimPrefix(fp, root+"/")
	}
	tmpBase := path.Base(tf.tmp)
	fail := func(err error) (*CompressResult, error) {
		tf.Abort()
		if pe, ok := protocol.AsError(err); ok {
			return nil, pe
		}
		return nil, MapError("compress", destRel, err)
	}
	// addFile archives one opened regular file and closes it before the next one is opened.
	addFile := func(name string, f *os.File, info fs.FileInfo) error {
		defer f.Close()
		total += info.Size()
		if total > p.MaxTotalBytes {
			return protocol.Errorf(protocol.CodeQuotaExceeded, "input exceeds %d bytes", p.MaxTotalBytes)
		}
		entries++
		return aw.file(name, info, f)
	}
	for _, in := range inputs {
		fi, err := r.r.Stat(in) // an input symlink is resolved inside the root (deny-checked above)
		if err != nil {
			return fail(MapError("compress", in, err))
		}
		switch {
		case fi.Mode().IsRegular():
			f, info, err := r.OpenForRead(in)
			if err == nil {
				err = addFile(nameOf(in), f, info)
			}
			if err != nil {
				return fail(err)
			}
			continue
		case !fi.IsDir():
			continue // special files are not archived
		}
		entries++
		if err := aw.dir(nameOf(in), fi); err != nil {
			return fail(err)
		}
		// Below an input directory nothing is followed: entries are opened relative to their opened
		// parent with no-follow semantics, and a symlink swapped in after the deny check is skipped.
		_, err = r.WalkTree(context.Background(), in, WalkOptions{
			MaxEntries: MaxWalkEntries,
			Skip: func(rel string, _ bool) (bool, bool) {
				skip := rel == dest || path.Base(rel) == tmpBase // never archive the archive being written
				return skip, skip
			},
		}, func(e *TreeEntry) error {
			if e.denied(r.deny) {
				return denyErr(displayPath(e.Rel))
			}
			switch {
			case e.Mode.IsDir():
				entries++
				return aw.dir(nameOf(e.Rel), e.Info)
			case e.Mode.IsRegular():
				f, info, err := e.Open()
				if err != nil {
					if Skipped(err) {
						return nil
					}
					return err
				}
				return addFile(nameOf(e.Rel), f, info)
			}
			return nil // symlinks and special files are not archived
		})
		if err != nil {
			return fail(err)
		}
	}
	if err := aw.close(); err != nil {
		return fail(err)
	}
	// Publish without overwriting: a concurrent creator of dest wins.
	if _, err := r.r.Lstat(dest); err == nil {
		tf.Abort()
		return nil, protocol.Errorf(protocol.CodeAlreadyExists, "%q already exists", destRel)
	}
	_, size, err := tf.Commit()
	if err != nil {
		return nil, err
	}
	return &CompressResult{Path: displayPath(dest), Size: size, Entries: entries}, nil
}
