// Package sftpd is the agent's built-in SFTP server (agent-protocol.md "SFTP service"). Logins are
// verified by the control plane; each session is confined to one workload data dir through the same
// os.Root sandbox as the fs.* commands.
package sftpd

import (
	"path"
	"strings"
)

// Denylist matches sandbox-relative paths against egg `file_denylist` patterns, a gitignore subset:
// `*`, `?`, `[...]` within a segment, `**` across segments, a leading or inner `/` anchors the
// pattern at the data root, patterns without `/` match any path component, a trailing `/` is
// ignored, `!` re-allows, `#` starts a comment. A match on a directory covers everything below it.
// The last matching pattern wins.
type Denylist struct{ rules []denyRule }

type denyRule struct {
	negate   bool
	anchored bool
	segs     []string
}

// NewDenylist compiles patterns (invalid glob syntax never matches).
func NewDenylist(patterns []string) *Denylist {
	d := &Denylist{}
	for _, p := range patterns {
		p = strings.TrimSpace(strings.ReplaceAll(p, `\`, "/"))
		if p == "" || strings.HasPrefix(p, "#") {
			continue
		}
		r := denyRule{}
		if strings.HasPrefix(p, "!") {
			r.negate = true
			p = p[1:]
		}
		p = strings.TrimRight(p, "/")
		if strings.HasPrefix(p, "/") {
			r.anchored = true
			p = strings.TrimLeft(p, "/")
		} else if strings.Contains(p, "/") {
			r.anchored = true
		}
		p = strings.TrimPrefix(path.Clean("/"+p), "/")
		if p == "" || p == "." {
			continue
		}
		r.segs = strings.Split(p, "/")
		d.rules = append(d.rules, r)
	}
	return d
}

// Denied reports whether rel (clean, "/"-separated, "." = root) or one of its parents is denied.
func (d *Denylist) Denied(rel string) bool {
	if d == nil || len(d.rules) == 0 || rel == "" || rel == "." {
		return false
	}
	segs := strings.Split(rel, "/")
	denied := false
	for _, r := range d.rules {
		if r.matches(segs) {
			denied = !r.negate
		}
	}
	return denied
}

func (r denyRule) matches(segs []string) bool {
	if !r.anchored {
		// One-segment pattern: any component (a matching directory covers its subtree).
		if len(r.segs) == 1 && r.segs[0] != "**" {
			for _, s := range segs {
				if ok, _ := path.Match(r.segs[0], s); ok {
					return true
				}
			}
			return false
		}
		return r.prefixMatch(append([]string{"**"}, r.segs...), segs)
	}
	return r.prefixMatch(r.segs, segs)
}

// prefixMatch: the pattern matches the path or any of its ancestors.
func (r denyRule) prefixMatch(pat, segs []string) bool {
	for k := 1; k <= len(segs); k++ {
		if globSegs(pat, segs[:k]) {
			return true
		}
	}
	return false
}

func globSegs(pat, segs []string) bool {
	if len(pat) == 0 {
		return len(segs) == 0
	}
	if pat[0] == "**" {
		for i := 0; i <= len(segs); i++ {
			if globSegs(pat[1:], segs[i:]) {
				return true
			}
		}
		return false
	}
	if len(segs) == 0 {
		return false
	}
	if ok, _ := path.Match(pat[0], segs[0]); !ok {
		return false
	}
	return globSegs(pat[1:], segs[1:])
}
