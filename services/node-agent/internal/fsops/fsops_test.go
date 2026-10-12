package fsops

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/flate"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/blockforge/node-agent/internal/protocol"
)

const wid = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"

func newRoot(t *testing.T) (*Root, string, string) {
	t.Helper()
	base := t.TempDir()
	s := &Sandbox{DataRoot: base, UID: 1000, GID: 1000}
	if err := s.EnsureDataDir(wid); err != nil {
		t.Fatal(err)
	}
	r, err := s.Open(wid)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close() })
	return r, s.DataDir(wid), base
}

func code(err error) protocol.ErrorCode {
	if err == nil {
		return ""
	}
	if pe, ok := protocol.AsError(err); ok {
		return pe.Code
	}
	return "non-protocol:" + protocol.ErrorCode(err.Error())
}

func expectCode(t *testing.T, err error, want protocol.ErrorCode) {
	t.Helper()
	if got := code(err); got != want {
		t.Fatalf("want %s, got %s (%v)", want, got, err)
	}
}

func symlinkOrSkip(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable on this platform: %v", err)
	}
}

func TestCleanPath(t *testing.T) {
	ok := map[string]string{"": ".", ".": ".", "./": ".", "server.properties": "server.properties",
		"world/region/": "world/region", "./a//b": "a/b"}
	for in, want := range ok {
		got, err := CleanPath(in, false)
		if err != nil || got != want {
			t.Errorf("CleanPath(%q)=%q,%v want %q", in, got, err, want)
		}
	}
	bad := []string{"../x", "a/../../x", "a/..", "/etc/passwd", `C:\x`, "c:x", `a\b`, "a\x00b", "CON", "nul.txt",
		"logs/COM1", "lpt3.log", ".."}
	for _, in := range bad {
		if _, err := CleanPath(in, false); err == nil {
			t.Errorf("CleanPath(%q) accepted", in)
		}
	}
	for _, in := range []string{"", ".", "./", "./."} {
		if _, err := CleanPath(in, true); err == nil {
			t.Errorf("mutable CleanPath(%q) accepted the root", in)
		}
	}
}

func TestTraversalAndSymlinkEscape(t *testing.T) {
	r, data, base := newRoot(t)
	outside := filepath.Join(base, "outside")
	os.MkdirAll(outside, 0o755)
	os.WriteFile(filepath.Join(outside, "secret"), []byte("TOP SECRET"), 0o644)

	// Relative symlink escaping the root, absolute symlink, symlinked parent dir.
	symlinkOrSkip(t, filepath.Join("..", "..", "..", "outside", "secret"), filepath.Join(data, "escape"))
	symlinkOrSkip(t, outside, filepath.Join(data, "abs"))
	symlinkOrSkip(t, filepath.Join("..", "..", "..", "outside"), filepath.Join(data, "parentdir"))
	// A symlink that stays inside is fine.
	os.WriteFile(filepath.Join(data, "real.txt"), []byte("inside"), 0o644)
	symlinkOrSkip(t, "real.txt", filepath.Join(data, "inner"))

	for _, p := range []string{"escape", "abs/secret", "parentdir/secret"} {
		_, err := r.Read(p, 100)
		expectCode(t, err, protocol.CodePathForbidden)
	}
	if _, _, err := r.List("parentdir"); code(err) != protocol.CodePathForbidden {
		t.Fatalf("list via symlinked parent: %v", err)
	}
	_, err := r.Write(protocol.FsWritePayload{Path: "parentdir/planted", Content: "x", Encoding: "utf8"})
	expectCode(t, err, protocol.CodePathForbidden)
	_, err = r.Write(protocol.FsWritePayload{Path: "parentdir/sub/planted", Content: "x", Encoding: "utf8", CreateParents: true})
	expectCode(t, err, protocol.CodePathForbidden)
	expectCode(t, r.Mkdir("abs/newdir"), protocol.CodePathForbidden)
	expectCode(t, r.Delete("parentdir/secret", false), protocol.CodePathForbidden)
	expectCode(t, r.Rename("real.txt", "parentdir/moved"), protocol.CodePathForbidden)
	_, err = r.Extract(protocol.FsExtractPayload{ArchivePath: "real.txt", DestPath: "parentdir", MaxTotalBytes: 10, MaxEntries: 10})
	if code(err) != protocol.CodePathForbidden {
		t.Fatalf("extract into escaping dest: %v", err)
	}

	// Deleting the escaping symlink removes the link, never the target.
	if err := r.Delete("parentdir", true); err != nil {
		t.Fatalf("delete symlink: %v", err)
	}
	if b, err := os.ReadFile(filepath.Join(outside, "secret")); err != nil || string(b) != "TOP SECRET" {
		t.Fatal("outside file was touched")
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 1 {
		t.Fatalf("files planted outside the sandbox: %v", entries)
	}
	res, err := r.Read("inner", 100)
	if err != nil || res.Content != "inside" {
		t.Fatalf("inside symlink: %v %+v", err, res)
	}
	// Plain traversal is rejected before touching the filesystem.
	_, err = r.Read("../../outside/secret", 100)
	expectCode(t, err, protocol.CodePathForbidden)
}

func sha(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func TestWriteIfMatchAndAtomicity(t *testing.T) {
	r, data, _ := newRoot(t)
	null := protocol.OptionalNullableString{Set: true, Null: true}
	w := func(content string, ifm protocol.OptionalNullableString) (*WriteResult, error) {
		return r.Write(protocol.FsWritePayload{Path: "server.properties", Content: content, Encoding: "utf8", IfMatchSha256: ifm})
	}
	res, err := w("a=1\n", null)
	if err != nil || res.Sha256 != sha("a=1\n") || res.Size != 4 {
		t.Fatalf("create: %v %+v", err, res)
	}
	_, err = w("a=2\n", null)
	expectCode(t, err, protocol.CodeAlreadyExists)
	_, err = w("a=2\n", protocol.OptionalNullableString{Set: true, Value: sha("wrong")})
	expectCode(t, err, protocol.CodeConflict)
	pe, _ := protocol.AsError(err)
	if pe.Details.(map[string]any)["currentSha256"] != sha("a=1\n") {
		t.Fatalf("conflict details: %+v", pe.Details)
	}
	if _, err := w("a=2\n", protocol.OptionalNullableString{Set: true, Value: sha("a=1\n")}); err != nil {
		t.Fatalf("matching ifMatch: %v", err)
	}
	if _, err := w("a=3\n", protocol.OptionalNullableString{}); err != nil {
		t.Fatalf("unconditional: %v", err)
	}
	_, err = r.Write(protocol.FsWritePayload{Path: "missing.txt", Content: "x", Encoding: "utf8",
		IfMatchSha256: protocol.OptionalNullableString{Set: true, Value: sha("x")}})
	expectCode(t, err, protocol.CodeConflict)
	_, err = r.Write(protocol.FsWritePayload{Path: "no/such/dir/f", Content: "x", Encoding: "utf8"})
	expectCode(t, err, protocol.CodeNotFound)
	if _, err := r.Write(protocol.FsWritePayload{Path: "plugins/x/config.yml", Content: "k: v", Encoding: "utf8", CreateParents: true}); err != nil {
		t.Fatal(err)
	}
	// base64url (no padding) binary content
	if _, err := r.Write(protocol.FsWritePayload{Path: "bin.dat", Content: protocol.B64.EncodeToString([]byte{0, 1, 2, 255}), Encoding: "base64"}); err != nil {
		t.Fatal(err)
	}
	_, err = r.Write(protocol.FsWritePayload{Path: "bin2.dat", Content: "AAEC_w==", Encoding: "base64"})
	expectCode(t, err, protocol.CodeValidationFailed)

	b, _ := os.ReadFile(filepath.Join(data, "server.properties"))
	if string(b) != "a=3\n" {
		t.Fatalf("content %q", b)
	}
	filepath.Walk(data, func(p string, fi os.FileInfo, err error) error {
		if strings.Contains(fi.Name(), ".bf-tmp-") {
			t.Errorf("temp file left behind: %s", p)
		}
		return nil
	})
	if runtime.GOOS != "windows" {
		os.Chmod(filepath.Join(data, "server.properties"), 0o600)
		w("a=4\n", protocol.OptionalNullableString{})
		fi, _ := os.Stat(filepath.Join(data, "server.properties"))
		if fi.Mode().Perm() != 0o600 {
			t.Fatalf("mode not preserved: %v", fi.Mode())
		}
	}
	_, err = r.Write(protocol.FsWritePayload{Path: "./", Content: "x", Encoding: "utf8"})
	expectCode(t, err, protocol.CodePathForbidden)
}

func TestReadEncodingsAndTruncation(t *testing.T) {
	r, data, _ := newRoot(t)
	os.WriteFile(filepath.Join(data, "t.txt"), []byte("héllo wörld"), 0o644)
	os.WriteFile(filepath.Join(data, "b.bin"), []byte{0x00, 0x01, 0xff}, 0o644)
	res, err := r.Read("t.txt", 100)
	if err != nil || res.Encoding != "utf8" || res.Content != "héllo wörld" || res.Truncated || res.Sha256 != sha("héllo wörld") {
		t.Fatalf("utf8: %v %+v", err, res)
	}
	res, _ = r.Read("t.txt", 2) // cuts "é" in half → trimmed to "h", still utf8
	if res.Encoding != "utf8" || res.Content != "h" || !res.Truncated || res.Size != int64(len("héllo wörld")) || res.Sha256 != sha("héllo wörld") {
		t.Fatalf("truncated: %+v", res)
	}
	res, _ = r.Read("b.bin", 100)
	if res.Encoding != "base64" || res.Content != protocol.B64.EncodeToString([]byte{0, 1, 0xff}) {
		t.Fatalf("binary: %+v", res)
	}
	_, err = r.Read("", 10)
	expectCode(t, err, protocol.CodeValidationFailed)
	_, err = r.Read("nope", 10)
	expectCode(t, err, protocol.CodeNotFound)
}

func TestListStatDeleteRenameDu(t *testing.T) {
	r, data, _ := newRoot(t)
	os.MkdirAll(filepath.Join(data, "world", "region"), 0o755)
	os.WriteFile(filepath.Join(data, "world", "region", "r.0.0.mca"), make([]byte, 5000), 0o644)
	os.WriteFile(filepath.Join(data, "world", "level.dat"), make([]byte, 100), 0o644)
	os.WriteFile(filepath.Join(data, "server.jar"), make([]byte, 3000), 0o644)
	entries, truncated, err := r.List("")
	if err != nil || truncated {
		t.Fatal(err)
	}
	names := []string{}
	for _, e := range entries {
		names = append(names, e.Name+":"+e.Type)
	}
	if strings.Join(names, ",") != ".blockforge:dir,server.jar:file,world:dir" {
		t.Fatalf("list: %v", names)
	}
	st, err := r.Stat("world/level.dat")
	if err != nil || st.Size != 100 || st.Path != "world/level.dat" || st.Type != "file" {
		t.Fatalf("stat: %v %+v", err, st)
	}
	du, err := r.Du("", 1, 2)
	if err != nil || du.TotalBytes != 8100 || du.Children[0].Path != "world" || du.Children[0].Bytes != 5100 ||
		du.LargestFiles[0].Path != "world/region/r.0.0.mca" || len(du.LargestFiles) != 2 {
		t.Fatalf("du: %v %+v", err, du)
	}
	expectCode(t, r.Delete("world", false), protocol.CodeConflict)
	expectCode(t, r.Rename("server.jar", "world"), protocol.CodeAlreadyExists)
	expectCode(t, r.Rename("world", "world/region/inside"), protocol.CodeConflict)
	if err := r.Rename("server.jar", "paper.jar"); err != nil {
		t.Fatal(err)
	}
	if err := r.Delete("world", true); err != nil {
		t.Fatal(err)
	}
	expectCode(t, r.Delete("world", true), protocol.CodeNotFound)
	expectCode(t, r.Delete(".", true), protocol.CodePathForbidden)
	if _, err := os.Stat(data); err != nil {
		t.Fatal("data root removed")
	}
}

// --- archives -----------------------------------------------------------------------------

func writeArchive(t *testing.T, data, name string, b []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(data, name), b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func makeZip(t *testing.T, files map[string]string) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for n, c := range files {
		w, err := zw.Create(n)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(c))
	}
	zw.Close()
	return buf.Bytes()
}

func makeTar(t *testing.T, gz bool, hdrs ...*tar.Header) []byte {
	var buf bytes.Buffer
	var w io.Writer = &buf
	var gzw *gzip.Writer
	if gz {
		gzw = gzip.NewWriter(&buf)
		w = gzw
	}
	tw := tar.NewWriter(w)
	for _, h := range hdrs {
		if h.Typeflag == tar.TypeReg && h.Size == 0 {
			h.Size = int64(len(h.Linkname))
		}
		body := h.Linkname
		if h.Typeflag == tar.TypeReg {
			h.Linkname = ""
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			tw.Write([]byte(body))
		}
	}
	tw.Close()
	if gzw != nil {
		gzw.Close()
	}
	return buf.Bytes()
}

func extract(r *Root, archive string, maxBytes, maxEntries int64) (*ExtractResult, error) {
	return r.Extract(protocol.FsExtractPayload{ArchivePath: archive, DestPath: "out", MaxTotalBytes: maxBytes, MaxEntries: maxEntries})
}

func TestExtractValid(t *testing.T) {
	r, data, _ := newRoot(t)
	writeArchive(t, data, "w.zip", makeZip(t, map[string]string{"world/level.dat": "LD", "world/region/": "", "eula.txt": "eula=true"}))
	res, err := extract(r, "w.zip", 1<<20, 100)
	if err != nil || res.Entries != 3 || res.Bytes != int64(len("LD")+len("eula=true")) {
		t.Fatalf("zip: %v %+v", err, res)
	}
	if b, _ := os.ReadFile(filepath.Join(data, "out", "world", "level.dat")); string(b) != "LD" {
		t.Fatal("zip content")
	}
	tgz := makeTar(t, true,
		&tar.Header{Name: "./", Typeflag: tar.TypeDir, Mode: 0o755},
		&tar.Header{Name: "plugins/", Typeflag: tar.TypeDir, Mode: 0o755},
		&tar.Header{Name: "plugins/a.jar", Typeflag: tar.TypeReg, Mode: 0o4755, Linkname: "JARDATA"})
	writeArchive(t, data, "p.tar.gz", tgz)
	res, err = extract(r, "p.tar.gz", 1<<20, 100)
	if err != nil || res.Bytes != 7 {
		t.Fatalf("tgz: %v %+v", err, res)
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(filepath.Join(data, "out", "plugins", "a.jar"))
		if fi.Mode()&os.ModeSetuid != 0 || fi.Mode().Perm() != 0o644 {
			t.Fatalf("archive mode bits must not be applied: %v", fi.Mode())
		}
	}
	writeArchive(t, data, "p.tar", makeTar(t, false, &tar.Header{Name: "x.txt", Typeflag: tar.TypeReg, Linkname: "hi"}))
	if _, err := extract(r, "p.tar", 1<<20, 100); err != nil {
		t.Fatalf("tar: %v", err)
	}
	writeArchive(t, data, "notarchive.txt", []byte("hello"))
	_, err = extract(r, "notarchive.txt", 1<<20, 100)
	expectCode(t, err, protocol.CodeValidationFailed)
}

func TestExtractRejectsMaliciousArchives(t *testing.T) {
	r, data, base := newRoot(t)
	cases := map[string][]byte{
		"zipslip.zip":   makeZip(t, map[string]string{"ok.txt": "x", "../../../../evil.txt": "pwned"}),
		"abs.zip":       makeZip(t, map[string]string{"/tmp/evil.txt": "pwned"}),
		"backslash.zip": makeZip(t, map[string]string{`..\..\evil.txt`: "pwned"}),
		"drive.zip":     makeZip(t, map[string]string{`C:/evil.txt`: "pwned"}),
		"symlink.tar":   makeTar(t, false, &tar.Header{Name: "link", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"}),
		"hardlink.tar": makeTar(t, false,
			&tar.Header{Name: "a.txt", Typeflag: tar.TypeReg, Linkname: "data"},
			&tar.Header{Name: "hl", Typeflag: tar.TypeLink, Linkname: "/etc/shadow"}),
		"device.tar.gz": makeTar(t, true, &tar.Header{Name: "dev", Typeflag: tar.TypeChar, Devmajor: 1, Devminor: 3}),
		"fifo.tar":      makeTar(t, false, &tar.Header{Name: "fifo", Typeflag: tar.TypeFifo}),
		"tarslip.tar.gz": makeTar(t, true,
			&tar.Header{Name: "fine.txt", Typeflag: tar.TypeReg, Linkname: "ok"},
			&tar.Header{Name: "a/../../evil.txt", Typeflag: tar.TypeReg, Linkname: "pwned"}),
	}
	// zip symlink entry
	var zbuf bytes.Buffer
	zw := zip.NewWriter(&zbuf)
	fh := &zip.FileHeader{Name: "link"}
	fh.SetMode(os.ModeSymlink | 0o777)
	w, _ := zw.CreateHeader(fh)
	w.Write([]byte("../../../etc/passwd"))
	zw.Close()
	cases["symlink.zip"] = zbuf.Bytes()

	for name, b := range cases {
		t.Run(name, func(t *testing.T) {
			writeArchive(t, data, name, b)
			_, err := extract(r, name, 1<<20, 100)
			expectCode(t, err, protocol.CodePathForbidden)
			// Nothing at all was written by a rejected archive (validation happens before extraction).
			if _, err := os.Stat(filepath.Join(data, "out", "ok.txt")); err == nil {
				t.Fatal("partial extraction before rejection")
			}
			if _, err := os.Stat(filepath.Join(data, "out", "fine.txt")); err == nil {
				t.Fatal("partial extraction before rejection")
			}
		})
	}
	for _, p := range []string{filepath.Join(base, "evil.txt"), filepath.Join(base, "servers", "evil.txt"), "/tmp/evil.txt"} {
		if _, err := os.Stat(p); err == nil {
			t.Fatalf("escaped write: %s", p)
		}
	}
}

func TestExtractBombsAndLimits(t *testing.T) {
	r, data, _ := newRoot(t)
	zeros := strings.Repeat("\x00", 10<<20) // 10 MiB → compresses to a few KiB
	writeArchive(t, data, "bomb.zip", makeZip(t, map[string]string{"a.bin": zeros}))
	_, err := extract(r, "bomb.zip", 1<<20, 100)
	expectCode(t, err, protocol.CodeQuotaExceeded)

	writeArchive(t, data, "bomb.tar.gz", makeTar(t, true, &tar.Header{Name: "a.bin", Typeflag: tar.TypeReg, Linkname: zeros}))
	_, err = extract(r, "bomb.tar.gz", 1<<20, 100)
	expectCode(t, err, protocol.CodeQuotaExceeded)

	many := map[string]string{}
	for i := 0; i < 20; i++ {
		many[strings.Repeat("f", i+1)] = "x"
	}
	writeArchive(t, data, "many.zip", makeZip(t, many))
	_, err = extract(r, "many.zip", 1<<20, 10)
	expectCode(t, err, protocol.CodeQuotaExceeded)

	// Zip whose headers lie about the uncompressed size: the declared size passes pass 1, but the
	// bytes actually decompressed are bounded and the extraction fails without exceeding the budget.
	var comp bytes.Buffer
	fw, _ := flate.NewWriter(&comp, flate.BestCompression)
	fw.Write([]byte(zeros))
	fw.Close()
	var zbuf bytes.Buffer
	zw := zip.NewWriter(&zbuf)
	raw, _ := zw.CreateRaw(&zip.FileHeader{Name: "liar.bin", Method: zip.Deflate,
		CRC32: crc32.ChecksumIEEE([]byte(zeros)), CompressedSize64: uint64(comp.Len()), UncompressedSize64: 100})
	raw.Write(comp.Bytes())
	zw.Close()
	writeArchive(t, data, "liar.zip", zbuf.Bytes())
	_, err = extract(r, "liar.zip", 1<<20, 10)
	if err == nil {
		t.Fatal("lying zip accepted")
	}
	if fi, err := os.Stat(filepath.Join(data, "out", "liar.bin")); err == nil && fi.Size() > 1<<20 {
		t.Fatalf("decompressed past the budget: %d", fi.Size())
	}
}

func TestFIFODoesNotHang(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no FIFOs on windows")
	}
	r, data, _ := newRoot(t)
	if err := mkfifo(filepath.Join(data, "pipe")); err != nil {
		t.Skip(err)
	}
	_, err := r.Read("pipe", 10)
	expectCode(t, err, protocol.CodePathForbidden)
}

func TestListTruncatedAtCap(t *testing.T) {
	r, data, _ := newRoot(t)
	old := MaxListEntries
	MaxListEntries = 5
	defer func() { MaxListEntries = old }()
	for i := 0; i < 5; i++ {
		os.WriteFile(filepath.Join(data, "f"+string(rune('a'+i))), nil, 0o644)
	}
	// .blockforge + 5 files = 6 entries > cap 5
	entries, truncated, err := r.List("")
	if err != nil || !truncated || len(entries) != 5 {
		t.Fatalf("cap: %v truncated=%v n=%d", err, truncated, len(entries))
	}
	os.Remove(filepath.Join(data, "fa"))
	entries, truncated, err = r.List("")
	if err != nil || truncated || len(entries) != 5 {
		t.Fatalf("exactly at cap must not be truncated: %v %v %d", err, truncated, len(entries))
	}
}
