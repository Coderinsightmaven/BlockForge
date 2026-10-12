//go:build !linux && !darwin && !freebsd

package fsops

import (
	"io/fs"
	"os"
	"time"
)

// fileID on Windows (development builds only): size, mtime and the file index (os.SameFile). There
// is no inode change time, so a same-size rewrite with a restored mtime is not detected here.
type fileID struct {
	size  int64
	mtime int64
	fi    fs.FileInfo
}

func idOf(fi fs.FileInfo) fileID {
	return fileID{size: fi.Size(), mtime: fi.ModTime().UnixNano(), fi: fi}
}

func (a fileID) same(b fileID) bool {
	return a.size == b.size && a.mtime == b.mtime && os.SameFile(a.fi, b.fi)
}

func (a fileID) settleWait(time.Time) time.Duration { return 0 }
