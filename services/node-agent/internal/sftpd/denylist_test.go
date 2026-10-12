package sftpd

import "testing"

func TestDenylist(t *testing.T) {
	d := NewDenylist([]string{
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
	if NewDenylist(nil).Denied("anything") {
		t.Fatal("empty list denies")
	}
	if NewDenylist([]string{"[invalid"}).Denied("[invalid") {
		t.Fatal("invalid glob must never match")
	}
}
