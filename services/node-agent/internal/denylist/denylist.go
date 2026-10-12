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
//
// Complexity: matching is memoised over (pattern segment, path segment), i.e. O(pattern segments ×
// path segments) per rule, and patterns with more than MaxPatternSegments segments or more than
// MaxDoubleStars `**` segments never match (like malformed globs): ignore files such as
// .blockforgeignore are workload-controlled. Path depth is deliberately not capped (a cap would make
// deep paths silently non-denied); paths are bounded by the 1024-character path limit anyway.
type List struct{ rules []denyRule }

// Pattern limits shared with packages/contracts/src/denylist.ts.
const (
	MaxPatternSegments = 64
	MaxDoubleStars     = 8
)

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
		if len(r.segs) > MaxPatternSegments || doubleStars(r.segs) > MaxDoubleStars {
			continue // never matches
		}
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

func doubleStars(segs []string) int {
	n := 0
	for _, s := range segs {
		if s == "**" {
			n++
		}
	}
	return n
}

// prefixMatch reports whether the pattern matches the path or any of its ancestors, i.e. some
// non-empty prefix segs[:k]. One memoised pass over (pattern index, path index):
// O(len(pat) × len(segs)) states, each evaluated at most once.
func (r denyRule) prefixMatch(pat, segs []string) bool {
	width := len(segs) + 1
	memo := make([]int8, (len(pat)+1)*width) // 0 unknown, 1 false, 2 true
	var match func(i, j int) bool
	match = func(i, j int) bool {
		key := i*width + j
		if v := memo[key]; v != 0 {
			return v == 2
		}
		var ok bool
		switch {
		case i == len(pat):
			ok = j >= 1 // the whole pattern matched a non-empty prefix
		case pat[i] == "**":
			ok = match(i+1, j) || (j < len(segs) && match(i, j+1))
		default:
			if j < len(segs) {
				if m, _ := path.Match(pat[i], segs[j]); m {
					ok = match(i+1, j+1)
				}
			}
		}
		if ok {
			memo[key] = 2
		} else {
			memo[key] = 1
		}
		return ok
	}
	return match(0, 0)
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
