//go:build linux || darwin || freebsd

package fsops

import (
	"io"
	"io/fs"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

// entStat is an lstat result: type, size and identity (device + inode).
type entStat struct {
	mode fs.FileMode
	size int64
	dev  uint64
	ino  uint64
}

// dirHandle is an open directory; children are reached with *at() syscalls relative to it, so a
// directory renamed or replaced after it was opened cannot redirect the walk.
type dirHandle struct {
	f  *os.File
	fd int
}

func newDirHandle(f *os.File) *dirHandle { return &dirHandle{f: f, fd: int(f.Fd())} }

func (d *dirHandle) file() *os.File { return d.f }
func (d *dirHandle) close()         { d.f.Close() }

func openRootDir(r *Root, start string) (*dirHandle, error) {
	f, err := r.r.OpenFile(start, os.O_RDONLY|unix.O_DIRECTORY|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	return newDirHandle(f), nil
}

// readNames reads all names, failing with errTooManyEntries beyond budget (bounds memory).
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

func retryEINTR(fn func() error) error {
	for {
		if err := fn(); err != unix.EINTR {
			return err
		}
	}
}

func modeOf(m uint32) fs.FileMode {
	perm := fs.FileMode(m & 0o777)
	switch m & unix.S_IFMT {
	case unix.S_IFDIR:
		return perm | fs.ModeDir
	case unix.S_IFREG:
		return perm
	case unix.S_IFLNK:
		return perm | fs.ModeSymlink
	case unix.S_IFIFO:
		return perm | fs.ModeNamedPipe
	case unix.S_IFSOCK:
		return perm | fs.ModeSocket
	case unix.S_IFCHR:
		return perm | fs.ModeDevice | fs.ModeCharDevice
	case unix.S_IFBLK:
		return perm | fs.ModeDevice
	}
	return perm | fs.ModeIrregular
}

// lstat stats name relative to the directory without following a symlink.
func (d *dirHandle) lstat(name string) (entStat, error) {
	var st unix.Stat_t
	if err := retryEINTR(func() error { return unix.Fstatat(d.fd, name, &st, unix.AT_SYMLINK_NOFOLLOW) }); err != nil {
		return entStat{}, &fs.PathError{Op: "lstat", Path: name, Err: err}
	}
	return entStat{mode: modeOf(uint32(st.Mode)), size: st.Size, dev: uint64(st.Dev), ino: uint64(st.Ino)}, nil
}

func sameObject(fi fs.FileInfo, want entStat) bool {
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && uint64(st.Dev) == want.dev && uint64(st.Ino) == want.ino
}

// openAt opens name relative to the directory with O_NOFOLLOW (a symlink fails with ELOOP) and
// O_NONBLOCK (a FIFO swapped in cannot hang the agent).
func (d *dirHandle) openAt(name string, flags int) (*os.File, fs.FileInfo, error) {
	var fd int
	err := retryEINTR(func() error {
		var e error
		fd, e = unix.Openat(d.fd, name, flags|unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
		return e
	})
	switch err {
	case nil:
	case unix.ELOOP, unix.ENOTDIR, unix.ENXIO, unix.EOPNOTSUPP:
		return nil, nil, ErrChanged // now a symlink / not a directory / a socket
	default:
		return nil, nil, &fs.PathError{Op: "open", Path: name, Err: err}
	}
	f := os.NewFile(uintptr(fd), name)
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	return f, fi, nil
}

// openDir opens a subdirectory and checks it is the directory lstat saw.
func (d *dirHandle) openDir(name string, want entStat) (*dirHandle, fs.FileInfo, error) {
	f, fi, err := d.openAt(name, unix.O_DIRECTORY)
	if err != nil {
		return nil, nil, err
	}
	if !fi.IsDir() || !sameObject(fi, want) {
		f.Close()
		return nil, nil, ErrChanged
	}
	return newDirHandle(f), fi, nil
}

// openFile opens a regular file and checks it is the file lstat saw.
func (d *dirHandle) openFile(name string, want entStat) (*os.File, fs.FileInfo, error) {
	f, fi, err := d.openAt(name, 0)
	if err != nil {
		return nil, nil, err
	}
	if !fi.Mode().IsRegular() || !sameObject(fi, want) {
		f.Close()
		return nil, nil, ErrChanged
	}
	return f, fi, nil
}
