//go:build linux || darwin || freebsd

package fsops

import (
	"io/fs"
	"syscall"
	"time"
)

// fileID is the content identity of an open file for fs.hash / jar.readEntries: device, inode,
// size, mtime and the inode change time. Every write, truncate, chmod or utimes sets ctime to the
// current time and an unprivileged process cannot set it back, so a same-size rewrite with a
// restored mtime still changes the identity (see settleWait for coarse timestamp clocks).
type fileID struct {
	dev, ino uint64
	size     int64
	mtime    int64 // ns since the epoch
	ctime    int64 // ns since the epoch; 0 = unknown
}

func idOf(fi fs.FileInfo) fileID {
	id := fileID{size: fi.Size(), mtime: fi.ModTime().UnixNano()}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		sec, nsec := statCtime(st)
		id.dev, id.ino, id.ctime = uint64(st.Dev), uint64(st.Ino), time.Unix(sec, nsec).UnixNano()
	}
	return id
}

func (a fileID) same(b fileID) bool { return a == b }

// settleWait is how long to wait before this identity can be relied on. Kernels without
// fine-grained ("multigrain", Linux 6.13+) timestamps stamp ctime from a coarse clock (one tick,
// ≤ 10 ms): a change in the same tick as the previous one would keep ctime. Once the last change is
// older than ctimeSettle, any later change gets a later ctime.
func (a fileID) settleWait(now time.Time) time.Duration {
	if a.ctime == 0 {
		return 0
	}
	age := now.Sub(time.Unix(0, a.ctime))
	if age < 0 || age >= ctimeSettle { // a ctime in the future (clock stepped back) cannot collide
		return 0
	}
	return ctimeSettle - age
}
