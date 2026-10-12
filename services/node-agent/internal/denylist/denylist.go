// Package denylist implements template `fileList` matching, shared by the fs.* commands and the
// SFTP server. Semantics are defined in packages/contracts/src/denylist.ts and pinned by
// packages/contracts/fixtures/denylist.json (tested in this package).
package denylist

import (
	"path"
	"strings"
)

// List matches sandbox-relative paths against egg `file_denylist` patterns, a gitignore subset:
// `*`, `?`, `[...]` within a segment, `**` across segments, a leading or inner `/` anchors the
// pattern at the data root, patterns without `/` match any path component, a trailing `/` is
// ignored, `!` re-allows, `#` starts a comment. A match on a directory covers everything below it.
// The last matching pattern wins.
type List struct{ rules []denyRule }

type denyRule struct {
	negate   bool
	anchored bool
	segs     []string
}

// New compiles patterns (invalid glob syntax never matches). An empty list returns nil, which
// denies nothing.
func New(patterns []string) *List {
	d := &List{}
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
	if len(d.rules) == 0 {
		return nil
	}
	return d
}

// Denied reports whether rel (clean, "/"-separated, "." = root) or one of its parents is denied.
func (d *List) Denied(rel string) bool {
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

// Active reports whether the list has any rule (nil-safe).
func (d *List) Active() bool { return d != nil && len(d.rules) > 0 }

// Negates reports whether any rule re-allows paths ("!pattern"); callers that prune whole directories
// must not do so when a negation could re-include something below them.
func (d *List) Negates() bool {
	if d == nil {
		return false
	}
	for _, r := range d.rules {
		if r.negate {
			return true
		}
	}
	return false
}
