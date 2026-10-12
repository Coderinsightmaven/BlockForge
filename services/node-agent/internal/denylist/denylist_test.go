package denylist

import (
	"strings"
	"testing"
	"time"
)

func TestLocalCases(t *testing.T) {
	d := New([]string{
		"# comment", "", "*.secret", "/config/private/", "plugins/**/token.yml", "logs", "!logs/keep.log", `\windows\style`,
	})
	cases := map[string]bool{
		"forwarding.secret":          true,
		"a/b/c.secret":               true,
		"secret":                     false,
		"config/private":             true,
		"config/private/x/y":         true,
		"other/config/private":       false, // anchored
		"plugins/a/token.yml":        true,
		"plugins/a/b/token.yml":      true,
		"plugins/token.yml":          true, // ** matches zero segments
		"token.yml":                  false,
		"logs":                       true,
		"logs/latest.log":            true,
		"world/logs/x":               true, // unanchored component match
		"logs/keep.log":              false,
		"windows/style":              true,
		"server.properties":          false,
		".":                          false,
		"config":                     false,
		"plugins/a/token.yml.bak":    false,
		"plugins/x.secret/inner.txt": true, // a directory named *.secret covers its subtree
	}
	for p, want := range cases {
		if got := d.Denied(p); got != want {
			t.Errorf("%s: got %v want %v", p, got, want)
		}
	}
	if New(nil).Denied("anything") {
		t.Fatal("empty list denies")
	}
	if New([]string{"[invalid"}).Denied("[invalid") {
		t.Fatal("invalid glob must never match")
	}
}

// TestPathologicalPatterns: `**`-heavy patterns (workload-controlled .blockforgeignore) on deep paths
// used to backtrack combinatorially; matching is memoised now and over-limit patterns never match.
func TestPathologicalPatterns(t *testing.T) {
	segs := make([]string, 0, 401)
	for i := 0; i < 400; i++ {
		segs = append(segs, "d"+strings.Repeat("x", i%7))
	}
	deep := strings.Join(append(segs, "zzz"), "/")
	d := New([]string{"**/**/**/**/**/**/**/**/x*y*z*q", "a/**/b/**/c/**/d/**/e", "**/d*/**/d*/**/d*/**/nomatch"})
	start := time.Now()
	for i := 0; i < 50; i++ {
		if d.Denied(deep) {
			t.Fatal("pathological pattern matched")
		}
	}
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("50 matches took %v", el)
	}
	// Deep paths are never cut off (no depth cap: that would fail open).
	if !New([]string{"zzz"}).Denied(deep) || !New([]string{"**/zzz"}).Denied(deep) || !New([]string{"/d/**/zzz"}).Denied(deep) {
		t.Fatal("deep path not denied")
	}
	// Limits: 8 '**' segments are fine, 9 never match; 64 segments are fine, 65 never match.
	if !New([]string{strings.Repeat("**/", 8) + "a"}).Denied("x/a") {
		t.Fatal("8 ** rejected")
	}
	if New([]string{strings.Repeat("**/", 9) + "a"}).Denied("x/a") {
		t.Fatal("9 ** matched")
	}
	p64 := strings.TrimSuffix(strings.Repeat("d/", 64), "/")
	p65 := p64 + "/d"
	if !New([]string{"/" + p64}).Denied(p64) || New([]string{"/" + p65}).Denied(p65) {
		t.Fatal("segment limit")
	}
	// Over-limit rules are dropped entirely, including negations.
	if !New([]string{"*.secret", "!" + strings.Repeat("**/", 9) + "a.secret"}).Denied("a.secret") {
		t.Fatal("over-limit negation took effect")
	}
}
