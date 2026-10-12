//go:build linux

package fsops

import (
	"os"
	"strconv"
	"strings"
)

// realRel maps an open file to its data-root-relative path via /proc/self/fd (race-free: it names
// the file actually opened).
func (r *Root) realRel(f *os.File) (string, bool) {
	p, err := os.Readlink("/proc/self/fd/" + strconv.Itoa(int(f.Fd())))
	if err != nil {
		return "", false
	}
	base := r.realDataDir()
	if base == "" {
		return "", false
	}
	switch {
	case p == base:
		return ".", true
	case strings.HasPrefix(p, base+"/"):
		return strings.TrimSuffix(strings.TrimPrefix(p, base+"/"), " (deleted)"), true
	}
	return "", false
}
