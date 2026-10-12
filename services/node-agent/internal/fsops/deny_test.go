package fsops

import (
	"archive/tar"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/blockforge/node-agent/internal/denylist"
	"github.com/blockforge/node-agent/internal/protocol"
)

func expectDenied(t *testing.T, what string, err error) {
	t.Helper()
	pe, ok := protocol.AsError(err)
	if !ok || pe.Code != protocol.CodePathForbidden {
		t.Fatalf("%s: want PATH_FORBIDDEN (denylist), got %v", what, err)
	}
	if d, _ := pe.Details.(map[string]any); d["reason"] != "denylist" {
		t.Fatalf("%s: details %v", what, pe.Details)
	}
}

func link(t *testing.T, target, at string) {
	t.Helper()
	if err := os.Symlink(target, at); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
}

// denyFixture: protected server.properties, config/private/, *.secret; plus symlinks a workload
// could plant to reach them under allowed names.
func denyFixture(t *testing.T) (*Root, string) {
	t.Helper()
	r, data, _ := newRoot(t)
	os.WriteFile(filepath.Join(data, "server.properties"), []byte("rcon.password=hunter2\n"), 0o644)
	os.MkdirAll(filepath.Join(data, "config", "private"), 0o755)
	os.WriteFile(filepath.Join(data, "config", "private", "token.txt"), []byte("TOKEN"), 0o644)
	os.WriteFile(filepath.Join(data, "config", "public.yml"), []byte("ok: true"), 0o644)
	os.WriteFile(filepath.Join(data, "plain.txt"), []byte("plain"), 0o644)
	os.MkdirAll(filepath.Join(data, "world"), 0o755)
	os.WriteFile(filepath.Join(data, "world", "level.dat"), []byte("LD"), 0o644)
	link(t, "server.properties", filepath.Join(data, "public.properties")) // symlinked file
	link(t, "config", filepath.Join(data, "pubdir"))                       // symlinked parent dir
	link(t, "public.properties", filepath.Join(data, "chain1"))            // chain → chain → denied
	link(t, "chain1", filepath.Join(data, "chain2"))
	link(t, "plain.txt", filepath.Join(data, "hop.secret")) // denied hop to an allowed file
	link(t, "hop.secret", filepath.Join(data, "via-hop"))
	os.MkdirAll(filepath.Join(data, "plugins"), 0o755)
	link(t, "../config/private", filepath.Join(data, "plugins", "cfglink"))
	return r.WithDenylist(denylist.New([]string{"server.properties", "/config/private", "*.secret"})), data
}

func TestDenylistResolvesSymlinks(t *testing.T) {
	r, data := denyFixture(t)
	for _, p := range []string{"server.properties", "public.properties", "chain2", "pubdir/private/token.txt", "via-hop", "plugins/cfglink/token.txt"} {
		_, err := r.Read(p, 100)
		expectDenied(t, "read "+p, err)
	}
	if res, err := r.Read("plain.txt", 100); err != nil || res.Content != "plain" {
		t.Fatalf("allowed read: %v", err)
	}
	if _, err := r.Read("pubdir/public.yml", 100); err != nil {
		t.Fatalf("allowed file through a symlinked parent: %v", err)
	}
	_, err := r.Write(protocol.FsWritePayload{Path: "public.properties", Content: "x", Encoding: "utf8"})
	expectDenied(t, "write via symlink", err)
	_, err = r.Write(protocol.FsWritePayload{Path: "pubdir/private/new.txt", Content: "x", Encoding: "utf8"})
	expectDenied(t, "write below symlinked denied dir", err)
	expectDenied(t, "mkdir", r.Mkdir("pubdir/private/sub"))
	expectDenied(t, "chmod", r.Chmod("chain2", 0o600))
	expectDenied(t, "delete link", r.Delete("public.properties", false))
	expectDenied(t, "rename link", r.Rename("public.properties", "x.properties"))
	expectDenied(t, "rename onto denied", r.Rename("plain.txt", "pubdir/private/plain.txt"))
	if b, _ := os.ReadFile(filepath.Join(data, "server.properties")); string(b) != "rcon.password=hunter2\n" {
		t.Fatal("protected file modified")
	}

	// Directory operations refuse when any entry below is denied.
	expectDenied(t, "delete tree", r.Delete("config", true))
	expectDenied(t, "rename tree", r.Rename("config", "cfg"))
	_, err = r.Copy("config")
	expectDenied(t, "copy tree", err)
	_, err = r.Copy("public.properties")
	expectDenied(t, "copy link", err)
	_, err = r.Compress(protocol.FsCompressPayload{Paths: []string{"config"}, Format: "zip", DestPath: "c.zip", MaxTotalBytes: 1 << 20}, timeNow())
	expectDenied(t, "compress tree", err)
	_, err = r.Compress(protocol.FsCompressPayload{Paths: []string{"world"}, Format: "zip", DestPath: "x.secret", MaxTotalBytes: 1 << 20}, timeNow())
	expectDenied(t, "compress into a denied name", err)
	if _, err := r.Compress(protocol.FsCompressPayload{Paths: []string{"world"}, Format: "zip", DestPath: "w.zip", MaxTotalBytes: 1 << 20}, timeNow()); err != nil {
		t.Fatalf("allowed compress: %v", err)
	}
	if _, err := r.Copy("world"); err != nil {
		t.Fatalf("allowed copy: %v", err)
	}
	if _, err := os.Stat(filepath.Join(data, "config")); err != nil {
		t.Fatal("refused tree delete removed data")
	}

	// Extract refuses archives with denied entry paths, also through symlinks in the destination.
	writeArchive(t, data, "evil.tar", makeTar(t, false, &tar.Header{Name: "config/private/planted", Typeflag: tar.TypeReg, Linkname: "x"}))
	_, err = r.Extract(protocol.FsExtractPayload{ArchivePath: "evil.tar", DestPath: "", MaxTotalBytes: 1 << 20, MaxEntries: 10})
	expectDenied(t, "extract denied entry", err)
	writeArchive(t, data, "evil2.tar", makeTar(t, false, &tar.Header{Name: "cfglink/planted", Typeflag: tar.TypeReg, Linkname: "x"}))
	_, err = r.Extract(protocol.FsExtractPayload{ArchivePath: "evil2.tar", DestPath: "plugins", MaxTotalBytes: 1 << 20, MaxEntries: 10})
	expectDenied(t, "extract through symlinked dir", err)
	if _, err := os.Stat(filepath.Join(data, "config", "private", "planted")); err == nil {
		t.Fatal("archive entry planted in a denied dir")
	}

	// Listings are unchanged.
	if entries, _, err := r.List(""); err != nil || len(entries) == 0 {
		t.Fatalf("list: %v", err)
	}
	if _, err := r.Stat("public.properties"); err != nil {
		t.Fatalf("stat: %v", err)
	}
	// Without a denylist nothing changes.
	plain := r.WithDenylist(nil)
	if _, err := plain.Read("public.properties", 100); err != nil {
		t.Fatalf("no denylist: %v", err)
	}
}

// A symlink swapped in after the pre-open check is caught by the post-open verification (Linux).
func TestDenylistVerifyOpenCatchesSwap(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("post-open verification uses /proc/self/fd")
	}
	r, _ := denyFixture(t)
	f, err := r.OSRoot().Open("server.properties") // what a swapped symlink would open
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	expectDenied(t, "verify", r.VerifyOpen(f, "innocent.txt"))
	g, _ := r.OSRoot().Open("plain.txt")
	defer g.Close()
	if err := r.VerifyOpen(g, "plain.txt"); err != nil {
		t.Fatalf("allowed file: %v", err)
	}
}

func TestCopyByteLimit(t *testing.T) {
	r, data, _ := newRoot(t)
	r.s.CopyMaxBytes = 100
	os.WriteFile(filepath.Join(data, "big.bin"), make([]byte, 200), 0o644)
	_, err := r.Copy("big.bin")
	expectCode(t, err, protocol.CodeQuotaExceeded)
	os.MkdirAll(filepath.Join(data, "tree", "sub"), 0o755)
	for _, n := range []string{"a", "b", "sub/c"} {
		os.WriteFile(filepath.Join(data, "tree", n), make([]byte, 50), 0o644)
	}
	_, err = r.Copy("tree")
	expectCode(t, err, protocol.CodeQuotaExceeded)
	// Free space minus the reserve also bounds the budget.
	r.s.CopyMaxBytes = 1 << 30
	r.s.FreeSpace = func(string) (int64, error) { return CopyFreeReserve + 40, nil }
	os.WriteFile(filepath.Join(data, "small.bin"), make([]byte, 60), 0o644)
	_, err = r.Copy("small.bin")
	expectCode(t, err, protocol.CodeQuotaExceeded)
	r.s.FreeSpace = nil
	// Streamed bytes are enforced too (a file that grows past the up-front size).
	cp := &copier{r: r, remaining: 10}
	expectCode(t, cp.copyFile("small.bin", "grown.bin", 0o644), protocol.CodeQuotaExceeded)
	for _, p := range []string{"big copy.bin", "tree copy", "small copy.bin", "grown.bin"} {
		if _, err := os.Lstat(filepath.Join(data, p)); err == nil {
			t.Fatalf("partial copy %s left behind", p)
		}
	}
	entries, _ := os.ReadDir(data)
	for _, e := range entries {
		if len(e.Name()) > 0 && e.Name()[0] == '.' && e.Name() != ".blockforge" {
			t.Fatalf("temp file left: %s", e.Name())
		}
	}
	if p, err := r.Copy("small.bin"); err != nil || p != "small copy.bin" {
		t.Fatalf("within budget: %v %q", err, p)
	}
}
