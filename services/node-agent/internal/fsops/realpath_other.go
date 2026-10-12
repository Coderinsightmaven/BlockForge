//go:build !linux

package fsops

import "os"

// realRel is unavailable off Linux; the pre-open resolution check is the only denylist check.
func (r *Root) realRel(*os.File) (string, bool) { return "", false }

// realIs is unavailable off Linux (known=false): TreeEntry.Open relies on the device/inode check.
func (r *Root) realIs(*os.File, string) (ok, known bool) { return false, false }
