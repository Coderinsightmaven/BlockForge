//go:build linux

package fsops

import "syscall"

func statCtime(st *syscall.Stat_t) (sec, nsec int64) { return st.Ctim.Unix() }
