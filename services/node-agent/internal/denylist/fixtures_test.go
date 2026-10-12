package denylist

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestSharedFixtures runs packages/contracts/fixtures/denylist.json, which the TypeScript port
// (packages/contracts/src/denylist.ts) passes too.
func TestSharedFixtures(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "contracts", "fixtures", "denylist.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Sets []struct {
			Patterns []string        `json:"patterns"`
			Cases    map[string]bool `json:"cases"`
		} `json:"sets"`
	}
	if err := json.Unmarshal(b, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Sets) == 0 {
		t.Fatal("no fixture sets")
	}
	n := 0
	for i, set := range fx.Sets {
		d := New(set.Patterns)
		for p, want := range set.Cases {
			n++
			if got := d.Denied(p); got != want {
				t.Errorf("set %d %v: %q denied=%v want %v", i, set.Patterns, p, got, want)
			}
		}
	}
	t.Logf("%d shared fixture cases", n)
}
