//go:build !windows

package main

import (
	"io/fs"
	"os"
	"syscall"
)

func chownIfNeeded(path string, fi fs.FileInfo, uid, gid int) error {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok && int(st.Uid) == uid && int(st.Gid) == gid {
		return nil
	}
	return os.Lchown(path, uid, gid)
}
