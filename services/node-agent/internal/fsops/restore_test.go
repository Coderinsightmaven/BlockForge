package fsops

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/blockforge/node-agent/internal/protocol"
)

type tarEntry struct {
	name, body string
	dir        bool
}

// tarGz writes a .tar.gz with the given entries (in order) and returns it opened for reading.
func tarGz(t *testing.T, entries ...tarEntry) (*os.File, int64) {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		h := &tar.Header{Name: e.name, Mode: 0o644, Typeflag: tar.TypeReg, Size: int64(len(e.body))}
		if e.dir {
			h = &tar.Header{Name: e.name, Mode: 0o755, Typeflag: tar.TypeDir}
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		io.WriteString(tw, e.body)
	}
	tw.Close()
	gz.Close()
	p := filepath.Join(t.TempDir(), "a.tar.gz")
	if err := os.WriteFile(p, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f, int64(buf.Len())
}

// tree lists a directory as "rel=content" / "rel/" lines (sorted).
func tree(t *testing.T, dir string) string {
	t.Helper()
	var out []string
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || p == dir {
			return nil
		}
		rel := filepath.ToSlash(strings.TrimPrefix(p, dir+string(filepath.Separator)))
		if d.IsDir() {
			out = append(out, rel+"/")
			return nil
		}
		b, _ := os.ReadFile(p)
		out = append(out, rel+"="+string(b))
		return nil
	})
	sort.Strings(out)
	return strings.Join(out, ",")
}

func leftovers(t *testing.T, s *Sandbox) []string {
	t.Helper()
	var out []string
	names, _ := os.ReadDir(s.WorkloadBase(wid))
	for _, n := range names {
		if n.Name() != "data" {
			out = append(out, n.Name())
		}
	}
	area, _ := os.ReadDir(filepath.Join(s.DataDir(wid), ".blockforge"))
	for _, n := range area {
		if strings.HasPrefix(n.Name(), "restore-") {
			out = append(out, ".blockforge/"+n.Name())
		}
	}
	return out
}

func restoreFixture(t *testing.T) (*Sandbox, string) {
	t.Helper()
	s := &Sandbox{DataRoot: t.TempDir(), UID: 1000, GID: 1000}
	if err := s.EnsureDataDir(wid); err != nil {
		t.Fatal(err)
	}
	data := s.DataDir(wid)
	put(t, data, "server.properties", "old")
	put(t, data, "world/level.dat", "old-level")
	put(t, data, ".blockforge/jvm.json", "{}")
	return s, data
}

func restoreOpts(truncate bool) RestoreOptions {
	return RestoreOptions{ArchiveOptions: ArchiveOptions{MaxTotalBytes: 1 << 30, MaxEntries: 1000, KeepPerms: true}, Truncate: truncate,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

// TestRestoreFailureLeavesDataUntouched: review "agent backups" #4. The archive passes validation but
// extraction fails half-way (a file and then an entry below that file); the old data must survive in
// both modes, and no staging directory may be left behind.
func TestRestoreFailureLeavesDataUntouched(t *testing.T) {
	for _, truncate := range []bool{true, false} {
		s, data := restoreFixture(t)
		before := tree(t, data)
		f, size := tarGz(t, tarEntry{name: "aaa.txt", body: "new"}, tarEntry{name: "server.properties", body: "new"},
			tarEntry{name: "zzz", body: "file"}, tarEntry{name: "zzz/inner", body: "below a file"})
		_, err := s.RestoreArchive(wid, f, size, restoreOpts(truncate))
		if err == nil {
			t.Fatalf("truncate=%v: extraction should fail", truncate)
		}
		if got := tree(t, data); got != before {
			t.Fatalf("truncate=%v: data changed by a failed restore\n got %s\nwant %s", truncate, got, before)
		}
		if l := leftovers(t, s); len(l) != 0 {
			t.Fatalf("truncate=%v: leftovers %v", truncate, l)
		}
	}
}

func TestRestoreTruncateSwap(t *testing.T) {
	s, data := restoreFixture(t)
	put(t, data, "griefed.txt", "x")
	f, size := tarGz(t, tarEntry{name: "server.properties", body: "restored"}, tarEntry{name: "world/", dir: true},
		tarEntry{name: "world/level.dat", body: "restored-level"}, tarEntry{name: ".blockforge/jvm.json", body: "FROM-ARCHIVE"})
	var stages []string
	o := restoreOpts(true)
	o.Stage = func(stage, _ string) { stages = append(stages, stage) }
	var planned int64
	o.Planned = func(_, bytes int64) error { planned = bytes; return nil }
	res, err := s.RestoreArchive(wid, f, size, o)
	if err != nil {
		t.Fatal(err)
	}
	// The agent area comes from the previous data directory, never from the archive.
	if got := tree(t, data); got != ".blockforge/,.blockforge/jvm.json={},server.properties=restored,world/,world/level.dat=restored-level" {
		t.Fatalf("restored tree %s", got)
	}
	if res.Files != 3 || planned != int64(len("restored")+len("restored-level")+len("FROM-ARCHIVE")) || strings.Join(stages, ",") != "swap" {
		t.Fatalf("result %+v planned %d stages %v", res, planned, stages)
	}
	if l := leftovers(t, s); len(l) != 0 {
		t.Fatalf("leftovers %v", l)
	}
	// Planned can veto before anything is written.
	f2, size2 := tarGz(t, tarEntry{name: "other.txt", body: "x"})
	o.Planned = func(_, _ int64) error { return protocol.Errorf(protocol.CodeQuotaExceeded, "no room") }
	before := tree(t, data)
	_, err = s.RestoreArchive(wid, f2, size2, o)
	expectCode(t, err, protocol.CodeQuotaExceeded)
	if tree(t, data) != before || len(leftovers(t, s)) != 0 {
		t.Fatal("vetoed restore changed something")
	}
}

func TestRestoreMerge(t *testing.T) {
	s, data := restoreFixture(t)
	put(t, data, "extra.txt", "stays")
	put(t, data, "plugins/a.jar", "old-a")
	f, size := tarGz(t, tarEntry{name: "plugins/", dir: true}, tarEntry{name: "plugins/a.jar", body: "new-a"},
		tarEntry{name: "plugins/b.jar", body: "new-b"}, tarEntry{name: "newdir/x/y.txt", body: "y"},
		tarEntry{name: ".blockforge/jvm.json", body: "FROM-ARCHIVE"})
	if _, err := s.RestoreArchive(wid, f, size, restoreOpts(false)); err != nil {
		t.Fatal(err)
	}
	want := ".blockforge/,.blockforge/jvm.json={},extra.txt=stays,newdir/,newdir/x/,newdir/x/y.txt=y,plugins/,plugins/a.jar=new-a," +
		"plugins/b.jar=new-b,server.properties=old,world/,world/level.dat=old-level"
	if got := tree(t, data); got != want {
		t.Fatalf("merged tree\n got %s\nwant %s", got, want)
	}
	// A file/directory collision is found before anything moves.
	before := tree(t, data)
	f2, size2 := tarGz(t, tarEntry{name: "aaa.txt", body: "would move first"}, tarEntry{name: "world", body: "a file now"})
	_, err := s.RestoreArchive(wid, f2, size2, restoreOpts(false))
	expectCode(t, err, protocol.CodeConflict)
	if tree(t, data) != before || len(leftovers(t, s)) != 0 {
		t.Fatalf("conflicting merge changed something: %s / %v", tree(t, data), leftovers(t, s))
	}
}

// TestRecoverRestores simulates an agent crash at every point of the swap.
func TestRecoverRestores(t *testing.T) {
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	setup := func(t *testing.T) (*Sandbox, string) {
		s := &Sandbox{DataRoot: t.TempDir(), UID: 1000, GID: 1000}
		os.MkdirAll(s.WorkloadBase(wid), 0o750)
		return s, s.WorkloadBase(wid)
	}
	journal := func(t *testing.T, base string) {
		put(t, base, "restore.journal", `{"staging":"data.restore-100","old":"data.old-100"}`)
	}
	t.Run("crash between the renames rolls back", func(t *testing.T) {
		s, base := setup(t)
		journal(t, base)
		put(t, base, "data.old-100/world/level.dat", "old")
		put(t, base, "data.old-100/.blockforge/jvm.json", "{}")
		put(t, base, "data.restore-100/world/level.dat", "new")
		s.RecoverRestores(quiet)
		if got := tree(t, base); got != "data/,data/.blockforge/,data/.blockforge/jvm.json={},data/world/,data/world/level.dat=old" {
			t.Fatalf("got %s", got)
		}
	})
	t.Run("crash after the swap finishes it", func(t *testing.T) {
		s, base := setup(t)
		journal(t, base)
		put(t, base, "data/world/level.dat", "new")
		put(t, base, "data.old-100/world/level.dat", "old")
		put(t, base, "data.old-100/.blockforge/jvm.json", "{}")
		s.RecoverRestores(quiet)
		if got := tree(t, base); got != "data/,data/.blockforge/,data/.blockforge/jvm.json={},data/world/,data/world/level.dat=new" {
			t.Fatalf("got %s", got)
		}
	})
	t.Run("crash before the swap discards the staging copy", func(t *testing.T) {
		s, base := setup(t)
		journal(t, base)
		put(t, base, "data/world/level.dat", "current")
		put(t, base, "data.restore-100/world/level.dat", "new")
		s.RecoverRestores(quiet)
		if got := tree(t, base); got != "data/,data/world/,data/world/level.dat=current" {
			t.Fatalf("got %s", got)
		}
	})
	t.Run("no journal", func(t *testing.T) {
		s, base := setup(t)
		put(t, base, "data.restore-5/x", "partial extraction")
		put(t, base, "data.old-3/v", "older")
		put(t, base, "data.old-7/v", "newest")
		put(t, base, "spec.json", "{}")
		s.RecoverRestores(quiet)
		if got := tree(t, base); got != "data.old-3/,data.old-3/v=older,data/,data/v=newest,spec.json={}" {
			t.Fatalf("got %s", got)
		}
		// With a data directory, previous data directories are left alone; merge staging is removed.
		put(t, base, "data/.blockforge/restore-9/x", "staged")
		put(t, base, "data/.blockforge/jvm.json", "{}")
		s.RecoverRestores(quiet)
		if got := tree(t, base); got != "data.old-3/,data.old-3/v=older,data/,data/.blockforge/,data/.blockforge/jvm.json={},data/v=newest,spec.json={}" {
			t.Fatalf("got %s", got)
		}
	})
	t.Run("inconsistent state is left alone", func(t *testing.T) {
		s, base := setup(t)
		journal(t, base)
		put(t, base, "data/a", "1")
		put(t, base, "data.old-100/b", "2")
		put(t, base, "data.restore-100/c", "3")
		before := tree(t, base)
		s.RecoverRestores(quiet)
		if got := tree(t, base); got != before {
			t.Fatalf("got %s", got)
		}
	})
}
