package fsops

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/blockforge/node-agent/internal/protocol"
)

func put(t *testing.T, dir, rel, content string) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// walkAll walks the root and returns the visited paths ("/"-suffixed for directories) and the
// contents read through TreeEntry.Open.
func walkAll(t *testing.T, r *Root, o WalkOptions) ([]string, map[string]string, WalkStats, error) {
	t.Helper()
	var visited []string
	contents := map[string]string{}
	st, err := r.WalkTree(context.Background(), ".", o, func(e *TreeEntry) error {
		switch {
		case e.Mode.IsDir():
			if e.Info == nil || !e.Info.IsDir() {
				t.Fatalf("directory %s without Info", e.Rel)
			}
			visited = append(visited, e.Rel+"/")
		case e.Mode.IsRegular():
			f, _, err := e.Open()
			if err != nil {
				if Skipped(err) {
					return nil
				}
				return err
			}
			b, rerr := io.ReadAll(f)
			f.Close()
			if rerr != nil {
				return rerr
			}
			contents[e.Rel] = string(b)
			visited = append(visited, e.Rel)
		default:
			visited = append(visited, e.Rel+"@")
		}
		return nil
	})
	return visited, contents, st, err
}

func TestWalkTreeOrderSkipAndLimits(t *testing.T) {
	r, data, _ := newRoot(t)
	put(t, data, "b/2.txt", "2")
	put(t, data, "b/1.txt", "1")
	put(t, data, "a.txt", "a")
	put(t, data, "skip/x.txt", "x")
	put(t, data, "keepdir/in.txt", "in")
	visited, contents, st, err := walkAll(t, r, WalkOptions{Skip: func(rel string, isDir bool) (bool, bool) {
		switch rel {
		case "skip", ".blockforge":
			return true, true
		case "keepdir": // skipped but still descended (a "!" re-include below it)
			return true, false
		}
		return false, false
	}})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(visited, ","); got != "a.txt,b/,b/1.txt,b/2.txt,keepdir/in.txt" {
		t.Fatalf("visited %s", got)
	}
	if contents["b/2.txt"] != "2" || st.Entries < 7 || st.Changed != 0 || st.Vanished != 0 {
		t.Fatalf("contents %v stats %+v", contents, st)
	}
	_, _, _, err = walkAll(t, r, WalkOptions{MaxEntries: 3})
	expectCode(t, err, protocol.CodeQuotaExceeded)
	put(t, data, "d1/d2/d3/d4/f", "deep")
	_, _, _, err = walkAll(t, r, WalkOptions{MaxDepth: 3})
	expectCode(t, err, protocol.CodeQuotaExceeded)
	if _, _, _, err = walkAll(t, r, WalkOptions{MaxDepth: 5}); err != nil {
		t.Fatal(err)
	}
}

// TestWalkTreeReplacedEntriesAreNotFollowed is the exploit scenario of review "agent backups" #1: an
// entry the directory read saw as a regular file / directory is swapped for a symlink (to the agent
// area) right before it is opened. The walk must skip it, never follow it.
func TestWalkTreeReplacedEntriesAreNotFollowed(t *testing.T) {
	r, data, _ := newRoot(t)
	put(t, data, ".blockforge/secret", "AGENT-SECRET")
	put(t, data, "a.dat", "public")
	put(t, data, "world/level.dat", "level")
	probe := filepath.Join(data, "probe")
	symlinkOrSkip(t, "a.dat", probe)
	os.Remove(probe)
	swap := map[string]func(){
		"a.dat": func() {
			os.Remove(filepath.Join(data, "a.dat"))
			os.Symlink(".blockforge/secret", filepath.Join(data, "a.dat"))
		},
		"world": func() {
			os.RemoveAll(filepath.Join(data, "world"))
			os.Symlink(".blockforge", filepath.Join(data, "world"))
		},
	}
	visited, contents, st, err := walkAll(t, r, WalkOptions{
		Skip: func(rel string, _ bool) (bool, bool) {
			skip := rel == ".blockforge" || strings.HasPrefix(rel, ".blockforge/")
			return skip, skip
		},
		BeforeOpen: func(rel string) {
			if f := swap[rel]; f != nil {
				f()
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	for name, c := range contents {
		if strings.Contains(c, "AGENT-SECRET") {
			t.Fatalf("followed a swapped-in symlink: %s = %q", name, c)
		}
	}
	if len(contents) != 0 || st.Changed != 2 {
		t.Fatalf("visited %v contents %v stats %+v", visited, contents, st)
	}
}

// TestWalkTreeReplacedOrVanished: a file replaced by another file (different inode) is skipped as
// changed; removed entries are skipped as vanished; neither fails the walk.
func TestWalkTreeReplacedOrVanished(t *testing.T) {
	r, data, _ := newRoot(t)
	put(t, data, "a.txt", "original")
	put(t, data, "b.txt", "gone")
	put(t, data, "c/inner.txt", "gone too")
	put(t, data, "d.txt", "kept")
	put(t, data, "other.txt", "OTHER")
	_, contents, st, err := walkAll(t, r, WalkOptions{BeforeOpen: func(rel string) {
		switch rel {
		case "a.txt":
			if err := os.Rename(filepath.Join(data, "other.txt"), filepath.Join(data, "a.txt")); err != nil {
				t.Error(err)
			}
		case "b.txt":
			os.Remove(filepath.Join(data, "b.txt"))
		case "c":
			os.RemoveAll(filepath.Join(data, "c"))
		}
	}})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := contents["a.txt"]; ok || contents["d.txt"] != "kept" {
		t.Fatalf("contents %v", contents)
	}
	// other.txt was renamed away after the directory read: it vanished as well.
	if st.Changed != 1 || st.Vanished != 3 {
		t.Fatalf("stats %+v", st)
	}
}

// TestWalkTreeOpenErrorsFail: a file that cannot be opened (permission) is an error, not a skip.
func TestWalkTreeOpenErrorsFail(t *testing.T) {
	if os.Geteuid() == 0 || os.Geteuid() == -1 {
		t.Skip("needs a non-root Unix user (root bypasses permissions; covered via EMFILE in the backup tests)")
	}
	r, data, _ := newRoot(t)
	put(t, data, "locked.txt", "x")
	os.Chmod(filepath.Join(data, "locked.txt"), 0)
	defer os.Chmod(filepath.Join(data, "locked.txt"), 0o644)
	_, _, _, err := walkAll(t, r, WalkOptions{})
	if err == nil || Skipped(err) || errors.Is(err, fs.SkipDir) {
		t.Fatalf("unreadable file did not fail the walk: %v", err)
	}
}
