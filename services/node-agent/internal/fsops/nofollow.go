package fsops

import (
	"errors"
	"io/fs"
	"os"
	"strings"
)

// ErrNotRegular: the path names a directory, symlink, FIFO, socket or device, or passes through a
// symlink. OpenNoFollow never follows one, not even inside the sandbox.
var ErrNotRegular = errors.New("not a regular file reachable without following symlinks")

// beforeNoFollowOpen, if set, runs right before each path component is opened (tests simulate a
// concurrent swap between the lstat and the open).
var beforeNoFollowOpen func(rel string)

// OpenNoFollow opens the regular file clean (a CleanPath result) for reading without following any
// symlink: starting at the sandbox root, every directory on the way is opened relative to its already
// opened parent with no-follow semantics and checked to be the object lstat saw (device + inode), and
// so is the file itself; on Linux the opened file's real location must also still be clean. It uses
// the race-safe primitives of WalkTree, so on Linux nothing can redirect the open once a component
// is pinned.
//
// Errors: ErrNotRegular (a symlink anywhere on the path, or a final object that is not a regular
// file), fs.ErrNotExist (a component is missing or a parent is not a directory), ErrChanged (a
// component was replaced between its lstat and its open), or an I/O error.
func (r *Root) OpenNoFollow(clean string) (*os.File, fs.FileInfo, error) {
	if clean == "." || clean == "" {
		return nil, nil, ErrNotRegular
	}
	d, err := openRootDir(r, ".")
	if err != nil {
		return nil, nil, err
	}
	defer func() { d.close() }()
	segs := strings.Split(clean, "/")
	rel := ""
	for i, name := range segs {
		rel = joinRel(rel, name)
		last := i == len(segs)-1
		st, err := d.lstat(name)
		if err != nil {
			return nil, nil, err
		}
		switch {
		case st.mode&fs.ModeSymlink != 0:
			return nil, nil, ErrNotRegular
		case last && !st.mode.IsRegular():
			return nil, nil, ErrNotRegular
		case !last && !st.mode.IsDir():
			return nil, nil, &fs.PathError{Op: "open", Path: rel, Err: fs.ErrNotExist}
		}
		if beforeNoFollowOpen != nil {
			beforeNoFollowOpen(rel)
		}
		if last {
			f, fi, err := d.openFile(name, st)
			if err != nil {
				return nil, nil, err
			}
			if ok, known := r.realIs(f, rel); known && !ok {
				f.Close()
				return nil, nil, ErrChanged
			}
			return f, fi, nil
		}
		sub, _, err := d.openDir(name, st)
		if err != nil {
			return nil, nil, err
		}
		d.close()
		d = sub
	}
	return nil, nil, ErrNotRegular // unreachable: segs is never empty
}
