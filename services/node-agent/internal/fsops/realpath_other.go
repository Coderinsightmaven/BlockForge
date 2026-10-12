//go:build !linux

package fsops

import "os"

// realRel is unavailable off Linux; the pre-open resolution check is the only denylist check.
func (r *Root) realRel(*os.File) (string, bool) { return "", false }
