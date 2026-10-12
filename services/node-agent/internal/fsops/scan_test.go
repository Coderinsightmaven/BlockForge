package fsops

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"fmt"
	"io/fs"
	"math/rand/v2"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/blockforge/node-agent/internal/denylist"
	"github.com/blockforge/node-agent/internal/protocol"
)

func tryLink(target, at string) bool { return os.Symlink(target, at) == nil }

func hashPayload(paths []string, algs ...string) *protocol.FsHashPayload {
	if len(algs) == 0 {
		algs = []string{"sha1", "sha256", "sha512"}
	}
	return &protocol.FsHashPayload{WorkloadID: wid, Paths: paths, Algorithms: algs, MaxBytesPerFile: 1 << 30, MaxTotalBytes: 16 << 30}
}

func mustHash(t *testing.T, r *Root, p *protocol.FsHashPayload) []protocol.FsHashEntry {
	t.Helper()
	res, err := r.Hash(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != len(p.Paths) {
		t.Fatalf("%d results for %d paths", len(res.Files), len(p.Paths))
	}
	for i, f := range res.Files {
		if f.Path != p.Paths[i] {
			t.Fatalf("result %d echoes %q, requested %q", i, f.Path, p.Paths[i])
		}
	}
	return res.Files
}

// outcome renders a result as "ok" or its error code.
func outcome[T protocol.FsHashEntry | protocol.JarReadResult](v T) string {
	switch x := any(v).(type) {
	case protocol.FsHashEntry:
		if x.OK {
			return "ok"
		}
		return x.Error
	case protocol.JarReadResult:
		if x.OK {
			return "ok"
		}
		return x.Error
	}
	return "?"
}

func TestHashVectors(t *testing.T) {
	r, data, _ := newRoot(t)
	million := strings.Repeat("a", 1_000_000)
	put(t, data, "plugins/abc.jar", "abc")
	put(t, data, "empty", "")
	put(t, data, "million", million)
	put(t, data, "nist", "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")
	big := make([]byte, 3<<20+17) // several read buffers
	rng := rand.New(rand.NewPCG(5, 6))
	for i := range big {
		big[i] = byte(rng.Uint32())
	}
	put(t, data, "big.bin", string(big))
	mtime := time.UnixMilli(1759913600123)
	os.Chtimes(filepath.Join(data, "plugins", "abc.jar"), mtime, mtime)

	files := mustHash(t, r, hashPayload([]string{"plugins/abc.jar", "empty", "million", "nist", "big.bin", "./plugins//abc.jar"}))
	s1, s256, s512 := sha1.Sum(big), sha256.Sum256(big), sha512.Sum512(big)
	want := [][3]string{
		{"a9993e364706816aba3e25717850c26c9cd0d89d", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
			"ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"},
		{"da39a3ee5e6b4b0d3255bfef95601890afd80709", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			"cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"},
		{"34aa973cd4c4daa4f61eeb2bdbad27316534016f", "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
			"e718483d0ce769644e2e42c7bc15b4638e1f98b13b2044285632a803afa973ebde0ff244877ea60a4cb0432ce577c31beb009c5c2c49aa2e4eadb217ad8cc09b"},
		{"84983e441c3bd26ebaae4aa1f95129e5e54670f1", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
			"204a8fc6dda82f0a0ced7beb8e08a41657c16ef468b228a8279be331a703c33596fd15c13b1b07f9aa1d3bea57789ca031ad85c7a71dd70354ec631238ca3445"},
		{hex.EncodeToString(s1[:]), hex.EncodeToString(s256[:]), hex.EncodeToString(s512[:])},
		{"a9993e364706816aba3e25717850c26c9cd0d89d", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
			"ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"},
	}
	for i, f := range files {
		if !f.OK || f.Sha1 != want[i][0] || f.Sha256 != want[i][1] || f.Sha512 != want[i][2] {
			t.Fatalf("%s: %+v", f.Path, f)
		}
	}
	if files[0].SizeBytes != 3 || files[0].Mtime != 1759913600123 || files[2].SizeBytes != 1_000_000 || files[4].SizeBytes != int64(len(big)) {
		t.Fatalf("size/mtime %+v", files[0])
	}
	// Only the requested digests are present.
	files = mustHash(t, r, hashPayload([]string{"plugins/abc.jar"}, "sha512"))
	if files[0].Sha1 != "" || files[0].Sha256 != "" || files[0].Sha512 != want[0][2] {
		t.Fatalf("%+v", files[0])
	}
	b, _ := protocol.Marshal(files[0])
	if strings.Contains(string(b), "sha1") || strings.Contains(string(b), "sha256") {
		t.Fatal(string(b))
	}
}

func TestHashPerFileOutcomes(t *testing.T) {
	r, data, _ := newRoot(t)
	put(t, data, "plugins/a.jar", "abc")
	put(t, data, "plugins/sub/b.jar", "b")
	put(t, data, "big.jar", strings.Repeat("x", 1000))
	put(t, data, "config/private/token.txt", "TOKEN")
	put(t, data, "server.secret", "s")
	paths := []string{"plugins/a.jar", "missing.jar", "plugins/a.jar/x", "plugins", "", "CON", "big.jar", "plugins/sub/b.jar"}
	want := []string{"ok", "NOT_FOUND", "NOT_FOUND", "NOT_REGULAR", "NOT_REGULAR", "PATH_FORBIDDEN", "TOO_LARGE", "ok"}
	links := map[string]string{ // link → target (all inside or pointing out of the sandbox)
		"plugins/link.jar":  "a.jar",
		"linkdir":           "plugins",
		"abs.jar":           "/etc/passwd",
		"escape.jar":        "../../../outside",
		"plugins/up.jar":    "../big.jar",
		"pub.yml":           "config/private/token.txt",
		"plugins/cfg":       "../config",
		"plugins/dangling":  "nowhere",
		"plugins/loop1.jar": "loop2.jar",
		"plugins/loop2.jar": "loop1.jar",
	}
	symlinks := true
	for l, target := range links {
		if !tryLink(target, filepath.Join(data, filepath.FromSlash(l))) {
			symlinks = false
			break
		}
	}
	if symlinks {
		// Never followed — not even to a regular file inside the sandbox or through a parent directory.
		paths = append(paths, "plugins/link.jar", "linkdir/a.jar", "linkdir/sub/b.jar", "abs.jar", "escape.jar", "plugins/up.jar",
			"plugins/dangling", "plugins/loop1.jar")
		want = append(want, "NOT_REGULAR", "NOT_REGULAR", "NOT_REGULAR", "NOT_REGULAR", "NOT_REGULAR", "NOT_REGULAR", "NOT_REGULAR", "NOT_REGULAR")
	} else {
		t.Log("symlinks unavailable: symlink cases skipped")
	}
	if runtime.GOOS != "windows" {
		if err := mkfifo(filepath.Join(data, "plugins", "pipe.jar")); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, "plugins/pipe.jar") // must not block
		want = append(want, "NOT_REGULAR")
	}
	p := hashPayload(paths)
	p.MaxBytesPerFile = 999
	files := mustHash(t, r, p)
	for i, f := range files {
		if outcome(f) != want[i] {
			t.Errorf("%q: got %s want %s", f.Path, outcome(f), want[i])
		}
	}

	// Denylist: same semantics as the other fs commands (requested path, links passed, resolved target).
	dr := r.WithDenylist(denylist.New([]string{"*.secret", "/config/private"}))
	paths = []string{"server.secret", "config/private/token.txt", "plugins/a.jar"}
	want = []string{"PATH_FORBIDDEN", "PATH_FORBIDDEN", "ok"}
	if symlinks {
		paths = append(paths, "pub.yml", "plugins/cfg/private/token.txt", "plugins/link.jar")
		want = append(want, "PATH_FORBIDDEN", "PATH_FORBIDDEN", "NOT_REGULAR")
	}
	files = mustHash(t, dr, hashPayload(paths))
	for i, f := range files {
		if outcome(f) != want[i] {
			t.Errorf("denylist %q: got %s want %s", f.Path, outcome(f), want[i])
		}
	}
}

func TestHashBudget(t *testing.T) {
	r, data, _ := newRoot(t)
	for _, n := range []string{"a", "b", "c", "d"} {
		put(t, data, n, strings.Repeat(n, 10))
	}
	put(t, data, "huge", strings.Repeat("h", 100))
	run := func(maxTotal int64, paths ...string) string {
		p := hashPayload(paths, "sha256")
		p.MaxTotalBytes, p.MaxBytesPerFile = maxTotal, 50
		var out []string
		for _, f := range mustHash(t, r, p) {
			out = append(out, outcome(f))
		}
		return strings.Join(out, ",")
	}
	cases := []struct {
		got, want string
	}{
		{run(25, "a", "b", "c", "d"), "ok,ok,BUDGET_EXCEEDED,BUDGET_EXCEEDED"},
		{run(20, "a", "b", "c"), "ok,ok,BUDGET_EXCEEDED"}, // exactly at the budget
		// The first file is always attempted (so a retry of the rest makes progress)…
		{run(1, "a", "b"), "ok,BUDGET_EXCEEDED"},
		// …failures that read nothing do not count, but once exhausted everything after is skipped.
		{run(15, "missing", "a", "huge", "b", "missing", "c"), "NOT_FOUND,ok,TOO_LARGE,BUDGET_EXCEEDED,BUDGET_EXCEEDED,BUDGET_EXCEEDED"},
		{run(15, "huge", "a", "b"), "TOO_LARGE,ok,BUDGET_EXCEEDED"},
	}
	for i, c := range cases {
		if c.got != c.want {
			t.Errorf("case %d: %s, want %s", i, c.got, c.want)
		}
	}
}

// Swaps between the lstat and the open of a component are detected (IO_ERROR, nothing of the swapped-in
// object is read); on Linux the dev/inode check and the pinned directory handles make this race-free.
func TestHashSwapRaces(t *testing.T) {
	r, data, _ := newRoot(t)
	secret := "AGENT-SECRET"
	put(t, data, ".blockforge/secret.jar", secret)
	put(t, data, ".blockforge/plugins/a.jar", secret)
	put(t, data, "plugins/a.jar", "public")
	put(t, data, "other.jar", "other")
	sum := sha256.Sum256([]byte(secret))
	secretSum := hex.EncodeToString(sum[:])
	if !tryLink("x", filepath.Join(data, "probe")) {
		t.Skip("symlinks unavailable")
	}
	os.Remove(filepath.Join(data, "probe"))
	reset := func() {
		os.RemoveAll(filepath.Join(data, "plugins"))
		put(t, data, "plugins/a.jar", "public")
		put(t, data, "plugins/b.jar", "replacement") // exists concurrently: a different inode for sure
	}
	cases := []struct {
		name, at string
		swap     func()
		want     string
	}{
		{"file → symlink", "plugins/a.jar", func() {
			os.Remove(filepath.Join(data, "plugins", "a.jar"))
			os.Symlink("../.blockforge/secret.jar", filepath.Join(data, "plugins", "a.jar"))
		}, "IO_ERROR"},
		{"parent → symlink", "plugins", func() {
			os.RemoveAll(filepath.Join(data, "plugins"))
			os.Symlink(".blockforge/plugins", filepath.Join(data, "plugins"))
		}, "IO_ERROR"},
		{"file → other file", "plugins/a.jar", func() {
			os.Rename(filepath.Join(data, "plugins", "b.jar"), filepath.Join(data, "plugins", "a.jar"))
		}, "IO_ERROR"},
		{"file removed", "plugins/a.jar", func() { os.Remove(filepath.Join(data, "plugins", "a.jar")) }, "NOT_FOUND"},
	}
	if runtime.GOOS != "windows" {
		cases = append(cases, struct {
			name, at string
			swap     func()
			want     string
		}{"file → FIFO", "plugins/a.jar", func() {
			os.Remove(filepath.Join(data, "plugins", "a.jar"))
			mkfifo(filepath.Join(data, "plugins", "a.jar"))
		}, "IO_ERROR"})
	}
	if runtime.GOOS == "linux" {
		// The pinned parent is moved elsewhere after it was opened: the file opened through it is the
		// right object but no longer at the requested path (real location check via /proc/self/fd).
		cases = append(cases, struct {
			name, at string
			swap     func()
			want     string
		}{"parent moved after open", "plugins/a.jar", func() {
			os.MkdirAll(filepath.Join(data, "moved"), 0o755)
			os.Rename(filepath.Join(data, "plugins"), filepath.Join(data, "moved", "plugins"))
		}, "IO_ERROR"})
	}
	t.Cleanup(func() { beforeNoFollowOpen = nil })
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			reset()
			done := false
			beforeNoFollowOpen = func(rel string) {
				if rel == c.at && !done {
					done = true
					c.swap()
				}
			}
			files := mustHash(t, r, hashPayload([]string{"plugins/a.jar", "other.jar"}, "sha256"))
			beforeNoFollowOpen = nil
			if !done || outcome(files[0]) != c.want || files[0].Sha256 == secretSum || outcome(files[1]) != "ok" {
				t.Fatalf("swapped=%v %+v", done, files)
			}
		})
	}
}

func TestDigestDetectsChangesWhileReading(t *testing.T) {
	_, data, _ := newRoot(t)
	put(t, data, "grow", "0123456789")
	put(t, data, "shrink", "0123456789")
	put(t, data, "touch", "0123456789")
	buf := make([]byte, 4)
	for name, change := range map[string]func(p string){
		"grow":   func(p string) { f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0); f.WriteString("more"); f.Close() },
		"shrink": func(p string) { os.Truncate(p, 3) },
		"touch": func(p string) {
			when := time.Now().Add(time.Hour)
			os.Chtimes(p, when, when)
		},
	} {
		p := filepath.Join(data, name)
		f, err := os.Open(p)
		if err != nil {
			t.Fatal(err)
		}
		fi, _ := f.Stat()
		change(p)
		if _, _, err := digestFile(context.Background(), f, fi, []string{"sha1"}, buf); err == nil {
			t.Errorf("%s: change not detected", name)
		}
		f.Close()
	}
}

// jarBytes builds a jar with archive/zip (deflate entries with data descriptors, like jar tools).
func jarBytes(t *testing.T, files [][2]string) []byte {
	t.Helper()
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	for _, f := range files {
		w, err := zw.Create(f[0])
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(f[1]))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func fixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "minecraft", "test", "fixtures", "extensions", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func jarPayload(paths, entries []string) *protocol.JarReadEntriesPayload {
	return &protocol.JarReadEntriesPayload{WorkloadID: wid, Paths: paths, Entries: entries, MaxEntryBytes: protocol.JarMaxEntryBytes,
		MaxJarBytes: 1 << 30, MaxTotalBytes: 4 << 20, Hash: []string{}}
}

func mustJars(t *testing.T, r *Root, p *protocol.JarReadEntriesPayload) []protocol.JarReadResult {
	t.Helper()
	res, err := r.ReadJarEntries(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Jars) != len(p.Paths) {
		t.Fatalf("%d results for %d paths", len(res.Jars), len(p.Paths))
	}
	for i, j := range res.Jars {
		if j.Path != p.Paths[i] {
			t.Fatalf("result %d echoes %q", i, j.Path)
		}
	}
	return res.Jars
}

func TestReadJarEntriesPluginsAndMods(t *testing.T) {
	r, data, _ := newRoot(t)
	pluginYml := fixture(t, "luckperms-bukkit-5.5.71.plugin.yml")
	modsToml := fixture(t, "ferritecore-6.0.1-forge.mods.toml")
	manifest := fixture(t, "ferritecore-6.0.1-forge.MANIFEST.MF")
	fabric := fixture(t, "ledger-1.3.5.fabric.mod.json")
	plugin := jarBytes(t, [][2]string{{"META-INF/MANIFEST.MF", "Manifest-Version: 1.0\r\n\x1b[31mred\r\n"}, {"plugin.yml", pluginYml},
		{"me/lucko/luckperms/Loader.class", "\xca\xfe\xba\xbe\x00\x00\x00\x41"}})
	mod := jarBytes(t, [][2]string{{"META-INF/MANIFEST.MF", manifest}, {"META-INF/mods.toml", modsToml}, {"fabric.mod.json", fabric}})
	put(t, data, "plugins/LuckPerms.jar", string(plugin))
	put(t, data, "mods/ferritecore.jar", string(mod))
	put(t, data, "plugins/notes.jar", "just text\n")
	put(t, data, "plugins/dup.jar", string(jarBytes(t, [][2]string{{"plugin.yml", "a"}, {"plugin.yml", "b"}})))
	symlinks := tryLink("LuckPerms.jar", filepath.Join(data, "plugins", "link.jar"))

	entries := []string{"paper-plugin.yml", "plugin.yml", "META-INF/mods.toml", "fabric.mod.json", "META-INF/MANIFEST.MF"}
	paths := []string{"plugins/LuckPerms.jar", "mods/ferritecore.jar", "plugins/notes.jar", "plugins/missing.jar", "plugins/dup.jar", "plugins"}
	if symlinks {
		paths = append(paths, "plugins/link.jar")
	}
	p := jarPayload(paths, entries)
	p.Hash = []string{"sha1", "sha512"}
	jars := mustJars(t, r, p)
	var got []string
	for _, j := range jars {
		got = append(got, outcome(j))
	}
	want := "ok,ok,NOT_A_ZIP,NOT_FOUND,AMBIGUOUS_ENTRY,NOT_REGULAR"
	if symlinks {
		want += ",NOT_REGULAR"
	}
	if strings.Join(got, ",") != want {
		t.Fatalf("outcomes %v", got)
	}
	lp, fc := jars[0], jars[1]
	s1, s512 := sha1.Sum(plugin), sha512.Sum512(plugin)
	if lp.Sha1 != hex.EncodeToString(s1[:]) || lp.Sha512 != hex.EncodeToString(s512[:]) || lp.SizeBytes != int64(len(plugin)) || lp.Mtime <= 0 {
		t.Fatalf("plugin jar %+v", lp)
	}
	if fmt.Sprint(lp.Missing) != "[paper-plugin.yml META-INF/mods.toml fabric.mod.json]" || len(lp.Entries) != 2 ||
		lp.Entries[0].Name != "plugin.yml" || lp.Entries[0].Content != pluginYml || lp.Entries[0].Truncated || lp.Entries[0].Size != int64(len(pluginYml)) ||
		lp.Entries[1].Content != "Manifest-Version: 1.0\r\n\uFFFD[31mred\r\n" {
		t.Fatalf("plugin entries %+v missing %v", lp.Entries, lp.Missing)
	}
	if fmt.Sprint(fc.Missing) != "[paper-plugin.yml plugin.yml]" || len(fc.Entries) != 3 || fc.Entries[0].Content != modsToml ||
		fc.Entries[1].Content != fabric || fc.Entries[2].Content != manifest || fc.Entries[2].Name != "META-INF/MANIFEST.MF" {
		t.Fatalf("mod entries %+v", fc.Entries)
	}

	// Truncation at maxEntryBytes (JSON-encoded, quotes included); size stays the declared size.
	p = jarPayload([]string{"mods/ferritecore.jar"}, []string{"META-INF/MANIFEST.MF"})
	p.MaxEntryBytes = 100
	e := mustJars(t, r, p)[0].Entries[0]
	if !e.Truncated || protocol.JSONStringLen(e.Content) > 100 || !strings.HasPrefix(manifest, e.Content) || e.Size != int64(len(manifest)) {
		t.Fatalf("truncated entry %+v (%d encoded)", e, protocol.JSONStringLen(e.Content))
	}
	// maxJarBytes is checked before anything is parsed.
	p = jarPayload([]string{"plugins/LuckPerms.jar", "mods/ferritecore.jar"}, []string{"plugin.yml"})
	p.MaxJarBytes = int64(len(plugin))
	if j := mustJars(t, r, p); outcome(j[0]) != "ok" || (len(mod) > len(plugin) && outcome(j[1]) != "TOO_LARGE") {
		t.Fatalf("maxJarBytes %v / %v", outcome(j[0]), outcome(j[1]))
	}
	// Denylist.
	dr := r.WithDenylist(denylist.New([]string{"/mods"}))
	if j := mustJars(t, dr, jarPayload([]string{"mods/ferritecore.jar", "plugins/LuckPerms.jar"}, []string{"plugin.yml"})); outcome(j[0]) != "PATH_FORBIDDEN" || outcome(j[1]) != "ok" {
		t.Fatal("denylist")
	}
}

func TestReadJarEntriesBudget(t *testing.T) {
	r, data, _ := newRoot(t)
	text := strings.Repeat("x", 1000) // 1002 bytes JSON-encoded
	for _, n := range []string{"a", "b", "c"} {
		put(t, data, n+".jar", string(jarBytes(t, [][2]string{{"plugin.yml", text}})))
	}
	run := func(maxTotal int64, paths ...string) string {
		p := jarPayload(paths, []string{"plugin.yml"})
		p.MaxTotalBytes = maxTotal
		var out []string
		for _, j := range mustJars(t, r, p) {
			out = append(out, outcome(j))
		}
		return strings.Join(out, ",")
	}
	cases := []struct{ got, want string }{
		{run(2004, "a.jar", "b.jar", "c.jar"), "ok,ok,BUDGET_EXCEEDED"},
		{run(2003, "a.jar", "b.jar", "c.jar"), "ok,BUDGET_EXCEEDED,BUDGET_EXCEEDED"},
		{run(10, "a.jar", "b.jar"), "ok,BUDGET_EXCEEDED"}, // the first jar is always returned
		{run(1500, "missing.jar", "a.jar", "b.jar", "missing.jar"), "NOT_FOUND,ok,BUDGET_EXCEEDED,BUDGET_EXCEEDED"},
	}
	for i, c := range cases {
		if c.got != c.want {
			t.Errorf("case %d: %s, want %s", i, c.got, c.want)
		}
	}
	// The whole result also has to fit in one frame (paths and names count too).
	old := scanFrameLimit
	t.Cleanup(func() { scanFrameLimit = old })
	scanFrameLimit = 1500
	if got := run(4<<20, "a.jar", "b.jar", "c.jar"); got != "ok,BUDGET_EXCEEDED,BUDGET_EXCEEDED" {
		t.Fatalf("frame guard: %s", got)
	}
}

type snapEntry struct {
	mode  fs.FileMode
	size  int64
	mtime time.Time
}

func snapshot(t *testing.T, dir string) map[string]snapEntry {
	t.Helper()
	out := map[string]snapEntry{}
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			t.Fatal(err)
		}
		fi, err := os.Lstat(p)
		if err != nil {
			t.Fatal(err)
		}
		out[p] = snapEntry{fi.Mode(), fi.Size(), fi.ModTime()}
		return nil
	})
	return out
}

// Neither scan writes anything: the data dir is identical afterwards (names, types, modes, sizes, mtimes).
func TestScansAreReadOnly(t *testing.T) {
	r, data, _ := newRoot(t)
	put(t, data, "plugins/a.jar", string(jarBytes(t, [][2]string{{"plugin.yml", "name: A"}})))
	put(t, data, "plugins/text.jar", "not a zip")
	put(t, data, "world/level.dat", "LD")
	tryLink("a.jar", filepath.Join(data, "plugins", "link.jar"))
	// Make everything older than "now" so an accidental write would show up as a new mtime.
	past := time.Now().Add(-time.Hour).Truncate(time.Second)
	filepath.WalkDir(data, func(p string, d fs.DirEntry, err error) error {
		if d.Type()&fs.ModeSymlink == 0 {
			os.Chtimes(p, past, past)
		}
		return nil
	})
	if runtime.GOOS != "windows" {
		filepath.WalkDir(data, func(p string, d fs.DirEntry, err error) error {
			if d.Type()&fs.ModeSymlink == 0 {
				if d.IsDir() {
					os.Chmod(p, 0o555)
				} else {
					os.Chmod(p, 0o444)
				}
			}
			return nil
		})
		t.Cleanup(func() {
			filepath.WalkDir(data, func(p string, d fs.DirEntry, err error) error {
				if d != nil && d.IsDir() {
					os.Chmod(p, 0o755)
				}
				return nil
			})
		})
	}
	before := snapshot(t, data)
	paths := []string{"plugins/a.jar", "plugins/text.jar", "plugins/link.jar", "world/level.dat", "plugins", "missing"}
	h := mustHash(t, r, hashPayload(paths))
	j := mustJars(t, r, &protocol.JarReadEntriesPayload{WorkloadID: wid, Paths: paths, Entries: []string{"plugin.yml"},
		MaxEntryBytes: 1024, MaxJarBytes: 1 << 20, MaxTotalBytes: 1 << 20, Hash: []string{"sha1", "sha512"}})
	if outcome(h[0]) != "ok" || outcome(j[0]) != "ok" || j[0].Entries[0].Content != "name: A" {
		t.Fatalf("%+v %+v", h[0], j[0])
	}
	after := snapshot(t, data)
	if len(before) != len(after) {
		t.Fatalf("entries changed: %d → %d", len(before), len(after))
	}
	keys := make([]string, 0, len(before))
	for k := range before {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if before[k] != after[k] {
			t.Fatalf("%s changed: %+v → %+v", k, before[k], after[k])
		}
	}
}

// A jar rewritten while it is read is IO_ERROR (retry) — also when the parser saw garbage, which would
// otherwise be reported as NOT_A_ZIP — with and without the whole-file hash.
func TestReadJarEntriesChangedWhileRead(t *testing.T) {
	r, data, _ := newRoot(t)
	jar := jarBytes(t, [][2]string{{"plugin.yml", strings.Repeat("name: Changing\n", 50)}})
	p := filepath.Join(data, "plugins", "c.jar")
	past := time.Now().Add(-time.Hour)
	t.Cleanup(func() { afterJarOpen = nil })
	for name, change := range map[string]func(){
		"appended":  func() { f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0); f.Write(jar); f.Close() },
		"truncated": func() { os.Truncate(p, int64(len(jar)/2)) },
		"directory overwritten in place": func() {
			f, _ := os.OpenFile(p, os.O_WRONLY, 0)
			f.WriteAt(bytes.Repeat([]byte{'Z'}, 40), int64(len(jar)-60))
			f.Close()
		},
	} {
		for _, hash := range [][]string{{}, {"sha512"}} {
			put(t, data, "plugins/c.jar", string(jar))
			os.Chtimes(p, past, past)
			afterJarOpen = func(string) { change() }
			pl := jarPayload([]string{"plugins/c.jar"}, []string{"plugin.yml"})
			pl.Hash = hash
			if got := outcome(mustJars(t, r, pl)[0]); got != "IO_ERROR" {
				t.Errorf("%s (hash %v): %s", name, hash, got)
			}
		}
	}
	afterJarOpen = nil
	put(t, data, "plugins/c.jar", string(jar))
	if got := outcome(mustJars(t, r, jarPayload([]string{"plugins/c.jar"}, []string{"plugin.yml"}))[0]); got != "ok" {
		t.Fatal(got)
	}
}

func TestScanCancellation(t *testing.T) {
	r, data, _ := newRoot(t)
	put(t, data, "a.jar", string(jarBytes(t, [][2]string{{"plugin.yml", "x"}})))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := r.Hash(ctx, hashPayload([]string{"a.jar"})); err == nil {
		t.Fatal("hash ignored cancellation")
	}
	if _, err := r.ReadJarEntries(ctx, jarPayload([]string{"a.jar"}, []string{"plugin.yml"})); err == nil {
		t.Fatal("jar read ignored cancellation")
	}
}
