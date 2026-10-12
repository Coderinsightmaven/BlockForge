//go:build !windows

package fsops

import (
	"os"
	"syscall"
)

// O_NONBLOCK makes opening a FIFO return immediately instead of hanging the agent; it has no
// effect on regular files.
const openReadFlags = os.O_RDONLY | syscall.O_NONBLOCK
