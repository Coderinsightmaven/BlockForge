//go:build darwin || freebsd

package fsops

import "syscall"

func statCtime(st *syscall.Stat_t) (sec, nsec int64) { return st.Ctimespec.Unix() }
