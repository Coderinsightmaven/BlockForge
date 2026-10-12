package fsops

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path"
	"sort"

	"github.com/blockforge/node-agent/internal/protocol"
)

// Errors returned by TreeEntry.Open for entries that are skipped (and counted in WalkStats) rather
// than failing the walk.
var (
	// ErrChanged: the entry was replaced between the directory read and the open (by a symlink, a
	// different file or directory, or it was moved elsewhere).
	ErrChanged = errors.New("entry changed while walking")
	// ErrVanished: the entry was removed between the directory read and the open.
	ErrVanished = errors.New("entry vanished while walking")
)

// Skipped reports whether err means "skip this entry" (ErrChanged or ErrVanished).
func Skipped(err error) bool { return errors.Is(err, ErrChanged) || errors.Is(err, ErrVanished) }

// DefaultMaxWalkDepth bounds directory nesting in WalkTree (each level holds one open directory).
const DefaultMaxWalkDepth = 512

// WalkOptions configure WalkTree.
type WalkOptions struct {
	// MaxEntries bounds the number of directory entries read (QUOTA_EXCEEDED beyond; default
	// MaxWalkEntries).
	MaxEntries int64
	// MaxDepth bounds directory nesting (QUOTA_EXCEEDED beyond; default DefaultMaxWalkDepth).
	MaxDepth int
	// Skip decides per entry (walked path, is a directory): skipEntry leaves the entry out; for a
	// directory, pruneDir also stops the walk from descending (without it, a skipped directory is
	// still walked so "!" re-includes below it work).
	Skip func(rel string, isDir bool) (skipEntry, pruneDir bool)
	// BeforeOpen, if set, runs right before an entry is opened (tests simulate concurrent changes).
	BeforeOpen func(rel string)
}

// WalkStats counts what a walk saw.
type WalkStats struct {
	Entries  int64 // directory entries read
	Changed  int64 // entries skipped because they were replaced meanwhile
	Vanished int64 // entries skipped because they were removed meanwhile
}

// TreeEntry is one entry met by WalkTree.
type TreeEntry struct {
	// Rel is the walked path (start + names below it), "/"-separated.
	Rel string
	// Mode is the lstat mode at walk time (symlinks are never followed).
	Mode fs.FileMode
	// Size is the lstat size at walk time.
	Size int64
	// Info is the fstat of the opened directory (directories only; nil otherwise).
	Info fs.FileInfo

	w    *walker
	dir  *dirHandle
	name string
	st   entStat
	real string // expected real location relative to the data root ("" = unknown)
}

// Open opens a regular-file entry without following symlinks and verifies that the opened file is
// the object the walk saw (same device and inode; on Linux also its real location via
// /proc/self/fd). It returns ErrChanged or ErrVanished (counted in WalkStats) when the entry was
// replaced or removed meanwhile; any other error is a real I/O error. The caller closes the file.
func (e *TreeEntry) Open() (*os.File, fs.FileInfo, error) {
	if !e.Mode.IsRegular() {
		return nil, nil, e.w.changed()
	}
	if e.w.o.BeforeOpen != nil {
		e.w.o.BeforeOpen(e.Rel)
	}
	f, fi, err := e.dir.openFile(e.name, e.st)
	if err != nil {
		return nil, nil, e.w.classify(e.Rel, err)
	}
	if !e.w.realMatches(f, e.real) {
		f.Close()
		return nil, nil, e.w.changed()
	}
	return f, fi, nil
}

type walker struct {
	r     *Root
	ctx   context.Context
	o     WalkOptions
	stats WalkStats
	fn    func(*TreeEntry) error
}

func (w *walker) changed() error {
	w.stats.Changed++
	return ErrChanged
}

// classify turns an open/stat error into ErrVanished / ErrChanged (counted) or a mapped I/O error.
func (w *walker) classify(rel string, err error) error {
	switch {
	case errors.Is(err, ErrChanged):
		return w.changed()
	case errors.Is(err, fs.ErrNotExist):
		w.stats.Vanished++
		return ErrVanished
	}
	return MapError("read", rel, err)
}

func (w *walker) realMatches(f *os.File, want string) bool {
	if want == "" {
		return true
	}
	ok, known := w.r.realIs(f, want)
	return ok || !known
}

// WalkTree walks the directory start (clean, sandbox-relative; symlinks in start itself are
// resolved inside the root) depth-first in lexical order without ever following a symlink below it:
// every directory is opened relative to its already-opened parent with no-follow semantics and
// checked to be the object the directory read saw, so a symlink or another object swapped in
// meanwhile is skipped (WalkStats.Changed) instead of followed. fn is called for each entry that
// Skip keeps, directories before their contents; it may return fs.SkipDir for a directory. Regular
// files are opened through TreeEntry.Open. Read errors (other than entries vanishing) fail the walk.
func (r *Root) WalkTree(ctx context.Context, start string, o WalkOptions, fn func(*TreeEntry) error) (WalkStats, error) {
	if o.MaxEntries <= 0 {
		o.MaxEntries = MaxWalkEntries
	}
	if o.MaxDepth <= 0 {
		o.MaxDepth = DefaultMaxWalkDepth
	}
	w := &walker{r: r, ctx: ctx, o: o, fn: fn}
	d, err := openStartDir(r, start)
	if err != nil {
		return w.stats, MapError("walk", displayPath(start), err)
	}
	defer d.close()
	real := ""
	if rr, ok := r.realRel(d.file()); ok {
		real = rr
	}
	err = w.walkDir(d, start, real, 1)
	return w.stats, err
}

func joinRel(dir, name string) string {
	if dir == "." || dir == "" {
		return name
	}
	return dir + "/" + name
}

func (w *walker) walkDir(d *dirHandle, rel, real string, depth int) error {
	if depth > w.o.MaxDepth {
		return protocol.Errorf(protocol.CodeQuotaExceeded, "directories nested deeper than %d levels", w.o.MaxDepth)
	}
	names, err := d.readNames(w.o.MaxEntries - w.stats.Entries)
	if err != nil {
		if errors.Is(err, errTooManyEntries) {
			return protocol.Errorf(protocol.CodeQuotaExceeded, "more than %d entries", w.o.MaxEntries)
		}
		return MapError("read directory", displayPath(rel), err)
	}
	w.stats.Entries += int64(len(names))
	sort.Strings(names)
	for _, name := range names {
		if err := w.ctx.Err(); err != nil {
			return err
		}
		child := joinRel(rel, name)
		childReal := ""
		if real != "" {
			childReal = joinRel(real, name)
		}
		st, err := d.lstat(name)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				w.stats.Vanished++
				continue
			}
			return MapError("stat", child, err)
		}
		isDir := st.mode.IsDir()
		skipEntry, prune := false, false
		if w.o.Skip != nil {
			skipEntry, prune = w.o.Skip(child, isDir)
		}
		if skipEntry && (!isDir || prune) {
			continue
		}
		e := &TreeEntry{Rel: child, Mode: st.mode, Size: st.size, w: w, dir: d, name: name, st: st, real: childReal}
		if !isDir {
			if err := w.fn(e); err != nil {
				return err
			}
			continue
		}
		if w.o.BeforeOpen != nil {
			w.o.BeforeOpen(child)
		}
		sub, info, err := d.openDir(name, st)
		if err != nil {
			if err = w.classify(child, err); Skipped(err) {
				continue
			}
			return err
		}
		if !w.realMatches(sub.file(), childReal) {
			sub.close()
			w.changed()
			continue
		}
		e.Info = info
		if !skipEntry {
			if err := w.fn(e); err != nil {
				sub.close()
				if errors.Is(err, fs.SkipDir) {
					continue
				}
				return err
			}
		}
		err = w.walkDir(sub, child, childReal, depth+1)
		sub.close()
		if err != nil {
			return err
		}
	}
	return nil
}

var errTooManyEntries = errors.New("too many entries")

// openStartDir opens the walk's start directory through the root (in-root symlinks in start are
// resolved by os.Root; callers have checked start itself).
func openStartDir(r *Root, start string) (*dirHandle, error) {
	if start == "" {
		start = "."
	}
	return openRootDir(r, path.Clean(start))
}

// denied reports whether m denies the entry by its walked path or (Linux) its real location.
func (e *TreeEntry) denied(m Matcher) bool {
	if m == nil {
		return false
	}
	return m.Denied(e.Rel) || (e.real != "" && m.Denied(e.real))
}
