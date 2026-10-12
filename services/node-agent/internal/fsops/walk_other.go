//go:build !linux && !darwin && !freebsd

package fsops

import (
	"io"
	"io/fs"
	"os"
	"syscall"
)

// Portable fallback (Windows development builds): paths are resolved through the root for every
// entry (no directory pinning), but every open is still checked to be the object lstat saw.

type entStat struct {
	mode fs.FileMode
	size int64
	fi   fs.FileInfo
}

type dirHandle struct {
	r   *Root
	rel string
	f   *os.File
}

func (d *dirHandle) file() *os.File { return d.f }
func (d *dirHandle) close()         { d.f.Close() }

func openRootDir(r *Root, start string) (*dirHandle, error) {
	f, err := r.r.Open(start)
	if err != nil {
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil || !fi.IsDir() {
		f.Close()
		if err == nil {
			err = &fs.PathError{Op: "open", Path: start, Err: syscall.ENOTDIR}
		}
		return nil, err
	}
	return &dirHandle{r: r, rel: start, f: f}, nil
}

func (d *dirHandle) readNames(budget int64) ([]string, error) {
	var names []string
	for {
		batch, err := d.f.Readdirnames(1024)
		names = append(names, batch...)
		if int64(len(names)) > budget {
			return nil, errTooManyEntries
		}
		if err == io.EOF {
			return names, nil
		}
		if err != nil {
			return nil, err
		}
	}
}

func (d *dirHandle) lstat(name string) (entStat, error) {
	fi, err := d.r.r.Lstat(joinRel(d.rel, name))
	if err != nil {
		return entStat{}, err
	}
	return entStat{mode: fi.Mode(), size: fi.Size(), fi: fi}, nil
}

func (d *dirHandle) openDir(name string, want entStat) (*dirHandle, fs.FileInfo, error) {
	p := joinRel(d.rel, name)
	f, err := d.r.r.Open(p)
	if err != nil {
		return nil, nil, err
	}
	fi, err := f.Stat()
	if err != nil || !fi.IsDir() || !os.SameFile(fi, want.fi) {
		f.Close()
		if err != nil {
			return nil, nil, err
		}
		return nil, nil, ErrChanged
	}
	return &dirHandle{r: d.r, rel: p, f: f}, fi, nil
}

func (d *dirHandle) openFile(name string, want entStat) (*os.File, fs.FileInfo, error) {
	f, err := d.r.r.OpenFile(joinRel(d.rel, name), openReadFlags, 0)
	if err != nil {
		return nil, nil, err
	}
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() || !os.SameFile(fi, want.fi) {
		f.Close()
		if err != nil {
			return nil, nil, err
		}
		return nil, nil, ErrChanged
	}
	return f, fi, nil
}
