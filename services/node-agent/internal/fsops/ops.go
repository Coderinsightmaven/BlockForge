package fsops

import (
	"bytes"
	"container/heap"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/blockforge/node-agent/internal/protocol"
)

// MaxListEntries caps fs.list results; truncated=true reports the cap (variable for tests).
var MaxListEntries = 50_000

// Limits for directory walks and writes.
const (
	MaxWalkEntries = 2_000_000
	MaxWriteBytes  = 7 * 1024 * 1024
)

func fileType(m fs.FileMode) string {
	switch {
	case m.IsRegular():
		return "file"
	case m.IsDir():
		return "dir"
	case m&fs.ModeSymlink != 0:
		return "symlink"
	}
	return "other"
}

func entryFor(name, p string, fi fs.FileInfo) protocol.FileEntry {
	return protocol.FileEntry{
		Name:       name,
		Path:       p,
		Type:       fileType(fi.Mode()),
		Size:       fi.Size(),
		ModifiedAt: fi.ModTime().UnixMilli(),
		Mode:       fmt.Sprintf("%04o", fi.Mode().Perm()),
	}
}

// List implements fs.list. truncated reports that the directory has more than MaxListEntries
// entries; the first MaxListEntries in directory order are returned, sorted by name.
func (r *Root) List(p string) (entries []protocol.FileEntry, truncated bool, err error) {
	dir, err := CleanPath(p, false)
	if err != nil {
		return nil, false, err
	}
	f, err := r.r.Open(dir)
	if err != nil {
		return nil, false, MapError("list", p, err)
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, false, MapError("list", p, err)
	}
	if !fi.IsDir() {
		return nil, false, protocol.Errorf(protocol.CodeValidationFailed, "%q is not a directory", p)
	}
	entries = []protocol.FileEntry{}
	for !truncated {
		batch, err := f.ReadDir(1024)
		for _, de := range batch {
			if len(entries) >= MaxListEntries {
				truncated = true
				break
			}
			info, ierr := de.Info()
			if ierr != nil {
				continue // raced with deletion
			}
			entries = append(entries, entryFor(de.Name(), path.Join(displayPath(dir), de.Name()), info))
		}
		if truncated || err == io.EOF || len(batch) == 0 {
			break
		}
		if err != nil {
			return nil, false, MapError("list", p, err)
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	return entries, truncated, nil
}

// Stat implements fs.stat (does not follow a final symlink).
func (r *Root) Stat(p string) (protocol.FileEntry, error) {
	name, err := CleanPath(p, false)
	if err != nil {
		return protocol.FileEntry{}, err
	}
	fi, err := r.r.Lstat(name)
	if err != nil {
		return protocol.FileEntry{}, MapError("stat", p, err)
	}
	return entryFor(path.Base(displayPath(name)), displayPath(name), fi), nil
}

// ReadResult is the fs.read result.
type ReadResult struct {
	Content   string `json:"content"`
	Encoding  string `json:"encoding"`
	Sha256    string `json:"sha256"`
	Size      int64  `json:"size"`
	Truncated bool   `json:"truncated"`
}

// Read implements fs.read. sha256 and size always describe the whole file so the value can be used
// as ifMatchSha256 in a later fs.write.
func (r *Root) Read(p string, maxBytes int64) (*ReadResult, error) {
	name, err := CleanPath(p, false)
	if err != nil {
		return nil, err
	}
	f, _, err := r.OpenForRead(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	h := sha256.New()
	var buf bytes.Buffer
	if _, err := io.Copy(io.MultiWriter(&buf, h), io.LimitReader(f, maxBytes)); err != nil {
		return nil, MapError("read", p, err)
	}
	rest, err := io.Copy(h, f)
	if err != nil {
		return nil, MapError("read", p, err)
	}
	data := buf.Bytes()
	res := &ReadResult{Sha256: hex.EncodeToString(h.Sum(nil)), Size: int64(len(data)) + rest, Truncated: rest > 0}
	text := data
	if res.Truncated {
		text = trimPartialRune(data)
	}
	if utf8.Valid(text) && !bytes.ContainsRune(text, 0) {
		res.Content, res.Encoding = string(text), "utf8"
	} else {
		res.Content, res.Encoding = protocol.B64.EncodeToString(data), "base64"
	}
	return res, nil
}

// trimPartialRune drops an incomplete UTF-8 sequence at the end of a truncated buffer.
func trimPartialRune(b []byte) []byte {
	for i := 1; i <= 3 && i <= len(b); i++ {
		c := b[len(b)-i]
		if c < 0x80 {
			return b
		}
		if c >= 0xC0 { // lead byte
			need := 2
			if c >= 0xF0 {
				need = 4
			} else if c >= 0xE0 {
				need = 3
			}
			if need > i {
				return b[:len(b)-i]
			}
			return b
		}
	}
	return b
}

// WriteResult is the fs.write result.
type WriteResult struct {
	Sha256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// Write implements fs.write: precondition check, temp file in the same directory, fsync, rename.
func (r *Root) Write(p protocol.FsWritePayload) (*WriteResult, error) {
	name, err := CleanPath(p.Path, true)
	if err != nil {
		return nil, err
	}
	if _, err := r.checkDeny(name); err != nil {
		return nil, err
	}
	var data []byte
	switch p.Encoding {
	case "utf8":
		data = []byte(p.Content)
	case "base64":
		data, err = protocol.B64.DecodeString(p.Content)
		if err != nil {
			return nil, protocol.Errorf(protocol.CodeValidationFailed, "content is not base64url without padding")
		}
	default:
		return nil, protocol.Errorf(protocol.CodeValidationFailed, "unknown encoding %q", p.Encoding)
	}
	if len(data) > MaxWriteBytes {
		return nil, protocol.Errorf(protocol.CodeQuotaExceeded, "content exceeds %d bytes", MaxWriteBytes)
	}
	parent := path.Dir(name)
	if p.CreateParents {
		if err := r.MkdirAll(parent); err != nil {
			return nil, err
		}
	} else if err := r.requireDir(parent); err != nil {
		return nil, err
	}

	mode := fs.FileMode(0o644)
	fi, statErr := r.r.Stat(name)
	exists := statErr == nil
	if statErr != nil && !errors.Is(statErr, fs.ErrNotExist) {
		return nil, MapError("stat", p.Path, statErr)
	}
	if exists {
		if fi.IsDir() {
			return nil, protocol.Errorf(protocol.CodeConflict, "%q is a directory", p.Path)
		}
		if !fi.Mode().IsRegular() {
			return nil, protocol.Errorf(protocol.CodePathForbidden, "%q is not a regular file", p.Path)
		}
		mode = fi.Mode().Perm()
	}
	if p.IfMatchSha256.Set {
		if p.IfMatchSha256.Null {
			if exists {
				return nil, protocol.Errorf(protocol.CodeAlreadyExists, "%q already exists", p.Path)
			}
		} else {
			if !exists {
				return nil, protocol.Errorf(protocol.CodeConflict, "%q does not exist", p.Path).
					WithDetails(map[string]any{"currentSha256": nil})
			}
			cur, _, err := r.hashFile(name)
			if err != nil {
				return nil, err
			}
			if !strings.EqualFold(cur, p.IfMatchSha256.Value) {
				return nil, protocol.Errorf(protocol.CodeConflict, "file changed since it was read").
					WithDetails(map[string]any{"currentSha256": cur})
			}
		}
	}
	tf, err := r.CreateTemp(name, mode)
	if err != nil {
		return nil, err
	}
	if _, err := tf.Write(data); err != nil {
		tf.Abort()
		return nil, MapError("write", p.Path, err)
	}
	sum, n, err := tf.Commit()
	if err != nil {
		return nil, err
	}
	return &WriteResult{Sha256: sum, Size: n}, nil
}

// Mkdir implements fs.mkdir (idempotent, creates parents).
func (r *Root) Mkdir(p string) error {
	name, err := CleanPath(p, true)
	if err != nil {
		return err
	}
	if _, err := r.checkDeny(name); err != nil {
		return err
	}
	return r.MkdirAll(name)
}

// Rename implements fs.rename; refuses to overwrite an existing destination.
func (r *Root) Rename(from, to string) error {
	src, err := CleanPath(from, true)
	if err != nil {
		return err
	}
	dst, err := CleanPath(to, true)
	if err != nil {
		return err
	}
	if err := r.checkDenyTree(src); err != nil {
		return err
	}
	if _, err := r.checkDeny(dst); err != nil {
		return err
	}
	if src == dst {
		return nil
	}
	if strings.HasPrefix(dst+"/", src+"/") {
		return protocol.Errorf(protocol.CodeConflict, "cannot move %q into itself", from)
	}
	if _, err := r.r.Lstat(src); err != nil {
		return MapError("rename", from, err)
	}
	if _, err := r.r.Lstat(dst); err == nil {
		return protocol.Errorf(protocol.CodeAlreadyExists, "%q already exists", to)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return MapError("rename", to, err)
	}
	if err := r.requireDir(path.Dir(dst)); err != nil {
		return err
	}
	if err := r.r.Rename(src, dst); err != nil {
		return MapError("rename", from, err)
	}
	return nil
}

// Delete implements fs.delete. Symlinks are removed, never followed.
func (r *Root) Delete(p string, recursive bool) error {
	name, err := CleanPath(p, true)
	if err != nil {
		return err
	}
	fi, err := r.r.Lstat(name)
	if err != nil {
		return MapError("delete", p, err)
	}
	if fi.IsDir() && recursive {
		err = r.checkDenyTree(name)
	} else {
		_, err = r.checkDeny(name)
	}
	if err != nil {
		return err
	}
	if fi.IsDir() && recursive {
		if err := r.r.RemoveAll(name); err != nil {
			return MapError("delete", p, err)
		}
		return nil
	}
	if fi.IsDir() {
		if d, err := r.r.Open(name); err == nil {
			names, _ := d.Readdirnames(1)
			d.Close()
			if len(names) > 0 {
				return protocol.Errorf(protocol.CodeConflict, "%q is not empty (use recursive)", p)
			}
		}
	}
	if err := r.r.Remove(name); err != nil {
		return MapError("delete", p, err)
	}
	return nil
}

// DuResult is the fs.du result.
type DuResult struct {
	TotalBytes   int64     `json:"totalBytes"`
	Children     []DuEntry `json:"children"`
	LargestFiles []DuEntry `json:"largestFiles"`
}

// DuEntry is a path with a byte count.
type DuEntry struct {
	Path  string `json:"path"`
	Bytes int64  `json:"bytes"`
}

type fileHeap []DuEntry

func (h fileHeap) Len() int           { return len(h) }
func (h fileHeap) Less(i, j int) bool { return h[i].Bytes < h[j].Bytes }
func (h fileHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *fileHeap) Push(x any)        { *h = append(*h, x.(DuEntry)) }
func (h *fileHeap) Pop() any {
	old := *h
	x := old[len(old)-1]
	*h = old[:len(old)-1]
	return x
}

// Du implements fs.du: apparent sizes of regular files, aggregated at `depth` below p, plus the
// `top` largest files. Symlinks are not followed. The walk is bounded by MaxWalkEntries.
func (r *Root) Du(p string, depth, top int) (*DuResult, error) {
	base, err := CleanPath(p, false)
	if err != nil {
		return nil, err
	}
	if fi, err := r.r.Stat(base); err != nil {
		return nil, MapError("du", p, err)
	} else if !fi.IsDir() {
		e := DuEntry{Path: displayPath(base), Bytes: fi.Size()}
		return &DuResult{TotalBytes: fi.Size(), Children: []DuEntry{e}, LargestFiles: []DuEntry{e}}, nil
	}
	res := &DuResult{Children: []DuEntry{}, LargestFiles: []DuEntry{}}
	agg := map[string]int64{}
	h := &fileHeap{}
	seen := 0
	walkErr := fs.WalkDir(r.r.FS(), base, func(fp string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable subtree: skip
		}
		seen++
		if seen > MaxWalkEntries {
			return fs.SkipAll
		}
		if !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		sz := info.Size()
		res.TotalBytes += sz
		rel := strings.TrimPrefix(strings.TrimPrefix(fp, base), "/")
		if base == "." {
			rel = fp
		}
		segs := strings.Split(rel, "/")
		key := displayPath(base)
		if depth > 0 {
			n := depth
			if n > len(segs) {
				n = len(segs)
			}
			key = path.Join(displayPath(base), strings.Join(segs[:n], "/"))
		}
		agg[key] += sz
		heap.Push(h, DuEntry{Path: path.Join(displayPath(base), rel), Bytes: sz})
		if h.Len() > top {
			heap.Pop(h)
		}
		return nil
	})
	if walkErr != nil {
		return nil, MapError("du", p, walkErr)
	}
	for k, v := range agg {
		res.Children = append(res.Children, DuEntry{Path: k, Bytes: v})
	}
	sort.Slice(res.Children, func(i, j int) bool {
		if res.Children[i].Bytes != res.Children[j].Bytes {
			return res.Children[i].Bytes > res.Children[j].Bytes
		}
		return res.Children[i].Path < res.Children[j].Path
	})
	if len(res.Children) > top {
		res.Children = res.Children[:top]
	}
	for h.Len() > 0 {
		res.LargestFiles = append(res.LargestFiles, heap.Pop(h).(DuEntry))
	}
	// heap pops ascending; present largest first
	for i, j := 0, len(res.LargestFiles)-1; i < j; i, j = i+1, j-1 {
		res.LargestFiles[i], res.LargestFiles[j] = res.LargestFiles[j], res.LargestFiles[i]
	}
	return res, nil
}

// DirSize sums apparent sizes of regular files below the root, bounded by maxEntries.
func (r *Root) DirSize(maxEntries int) (int64, bool) {
	var total int64
	seen := 0
	complete := true
	_ = fs.WalkDir(r.r.FS(), ".", func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		seen++
		if seen > maxEntries {
			complete = false
			return fs.SkipAll
		}
		if d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total, complete
}
