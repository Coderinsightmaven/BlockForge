package jarread

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/blockforge/node-agent/internal/jvmprobe"
	"github.com/blockforge/node-agent/internal/protocol"
)

// countingReaderAt counts the bytes read (to prove reads are bounded).
type countingReaderAt struct {
	r io.ReaderAt
	n atomic.Int64
}

func (c *countingReaderAt) ReadAt(p []byte, off int64) (int, error) {
	n, err := c.r.ReadAt(p, off)
	c.n.Add(int64(n))
	return n, err
}

func read(t testing.TB, b []byte, names []string, maxBytes int) (*Result, error) {
	t.Helper()
	return Read(context.Background(), bytes.NewReader(b), int64(len(b)), names, maxBytes, DefaultLimits)
}

func mustRead(t testing.TB, b []byte, names []string, maxBytes int) *Result {
	t.Helper()
	r, err := read(t, b, names, maxBytes)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func expectErr(t *testing.T, err, want error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("want %v, got %v", want, err)
	}
}

// goZip writes an archive with archive/zip (deflate entries use data descriptors, as jar tools do).
func goZip(t testing.TB, files map[string]string, stored ...string) []byte {
	t.Helper()
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	for _, n := range names {
		method := zip.Deflate
		for _, s := range stored {
			if s == n {
				method = zip.Store
			}
		}
		w, err := zw.CreateHeader(&zip.FileHeader{Name: n, Method: method})
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(files[n]))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// differential compares Read with archive/zip on every requested name.
func differential(t *testing.T, label string, b []byte, names []string, maxBytes int) {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatalf("%s: archive/zip: %v", label, err)
	}
	res := mustRead(t, b, names, maxBytes)
	got := map[string]Entry{}
	for _, e := range res.Entries {
		got[e.Name] = e
	}
	for _, n := range names {
		var want []byte
		var found bool
		for _, f := range zr.File {
			if f.Name == n {
				rc, err := f.Open()
				if err != nil {
					t.Fatal(err)
				}
				want, err = io.ReadAll(rc)
				rc.Close()
				if err != nil {
					t.Fatal(err)
				}
				found = true
			}
		}
		e, ok := got[n]
		if ok != found {
			t.Fatalf("%s: %q found=%v, archive/zip found=%v", label, n, ok, found)
		}
		if !found {
			continue
		}
		complete := len(want) <= maxBytes
		if e.Complete != complete || e.Size != uint64(len(want)) || !bytes.Equal(e.Data, want[:min(len(want), maxBytes)]) {
			t.Fatalf("%s: %q complete=%v size=%d len=%d, archive/zip %d bytes", label, n, e.Complete, e.Size, len(e.Data), len(want))
		}
	}
}

func TestRealJar(t *testing.T) {
	jar := jvmprobe.Jar()
	res := mustRead(t, jar, []string{"plugin.yml", "META-INF/MANIFEST.MF", "io/blockforge/jvmprobe/Agent.class"}, 256*1024)
	if len(res.Missing) != 1 || res.Missing[0] != "plugin.yml" || len(res.Entries) != 2 {
		t.Fatalf("%+v", res)
	}
	mf := res.Entries[0]
	if mf.Name != "META-INF/MANIFEST.MF" || !mf.Complete || !strings.Contains(string(mf.Data), "Premain-Class:") {
		t.Fatalf("manifest %+v %q", mf, mf.Data)
	}
	text, truncated := Text(mf.Data, mf.Complete, 256*1024)
	if truncated || text != string(mf.Data) {
		t.Fatalf("manifest text %q truncated=%v", text, truncated)
	}
	// Binary entry: complete (CRC verified), text is sanitised.
	cls, tr := Text(res.Entries[1].Data, res.Entries[1].Complete, 256*1024)
	if !res.Entries[1].Complete || tr || !utf8.ValidString(cls) || strings.ContainsRune(cls, 0) {
		t.Fatal("class entry")
	}
	differential(t, "jvm-probe.jar", jar, []string{"META-INF/MANIFEST.MF", "io/blockforge/jvmprobe/Agent.class", "io/"}, 256*1024)
	differential(t, "jvm-probe.jar small", jar, []string{"META-INF/MANIFEST.MF", "io/blockforge/jvmprobe/Agent.class"}, 100)
}

// TestRealJarsFromEnv runs the differential test against real jars when BF_REAL_JARS lists files or
// directories (os.PathListSeparator) — used for recorded runs against downloaded plugins/mods.
func TestRealJarsFromEnv(t *testing.T) {
	list := os.Getenv("BF_REAL_JARS")
	if list == "" {
		t.Skip("BF_REAL_JARS not set")
	}
	var jars []string
	for _, p := range filepath.SplitList(list) {
		fi, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if !fi.IsDir() {
			jars = append(jars, p)
			continue
		}
		m, _ := filepath.Glob(filepath.Join(p, "*.jar"))
		jars = append(jars, m...)
	}
	metadata := []string{"plugin.yml", "paper-plugin.yml", "bungee.yml", "velocity-plugin.json", "fabric.mod.json",
		"quilt.mod.json", "META-INF/mods.toml", "META-INF/neoforge.mods.toml", "META-INF/MANIFEST.MF", "mcmod.info"}
	for _, p := range jars {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
		if err != nil {
			t.Fatalf("%s: archive/zip: %v", p, err)
		}
		names := append([]string{}, metadata...)
		seen := map[string]int{}
		for _, f := range zr.File {
			seen[f.Name]++
		}
		for _, f := range zr.File { // plus some other files
			if len(names) >= 32 {
				break
			}
			if !strings.HasSuffix(f.Name, "/") && seen[f.Name] == 1 && !contains(names, f.Name) {
				names = append(names, f.Name)
			}
		}
		if len(zr.File) > DefaultLimits.MaxRecords {
			_, err := read(t, b, names, 256*1024)
			expectErr(t, err, ErrTooLarge)
			t.Logf("%s: %d entries → TOO_LARGE", filepath.Base(p), len(zr.File))
			continue
		}
		start := time.Now()
		differential(t, filepath.Base(p), b, names, 256*1024)
		differential(t, filepath.Base(p)+" (64 B)", b, names, 64)
		res := mustRead(t, b, names, 256*1024)
		var found []string
		for _, e := range res.Entries {
			if contains(metadata, e.Name) {
				found = append(found, e.Name)
			}
		}
		t.Logf("%s: %d entries, %d bytes, metadata %v, %v", filepath.Base(p), len(zr.File), len(b), found, time.Since(start))
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func TestStoredDeflateAndDescriptors(t *testing.T) {
	files := map[string]string{
		"plugin.yml":         "name: Test\nversion: 1.0\nmain: a.b.C\n",
		"META-INF/mods.toml": strings.Repeat("modLoader=\"javafml\"\n", 50),
		"empty.txt":          "",
		"dir/big.bin":        strings.Repeat("0123456789", 100_000),
	}
	b := goZip(t, files, "plugin.yml", "empty.txt")
	zr, _ := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	for _, f := range zr.File {
		if f.Method == zip.Deflate && f.Flags&0x8 == 0 {
			t.Fatal("expected data descriptors from archive/zip")
		}
	}
	names := []string{"plugin.yml", "META-INF/mods.toml", "empty.txt", "dir/big.bin", "nope"}
	differential(t, "go zip", b, names, 256*1024)
	differential(t, "go zip tiny", b, names, 7)
	res := mustRead(t, b, names, 256*1024)
	if fmt.Sprint(res.Missing) != "[nope]" || res.Entries[3].Complete || res.Entries[3].Size != 1_000_000 || len(res.Entries[3].Data) != 256*1024 {
		t.Fatalf("%+v", res.Missing)
	}

	// Handcrafted: stored, deflate, data descriptor with zero local sizes, Zip64 extra fields.
	hb := buildZip(t, []zentry{
		{name: "a.txt", data: []byte("stored")},
		{name: "b.txt", data: []byte("deflated deflated deflated"), method: 8},
		{name: "c.txt", data: []byte("descriptor"), method: 8, descriptor: true},
		{name: "d.txt", data: []byte("zip64 entry"), method: 8, zip64: true},
	}, zopts{})
	differential(t, "handcrafted", hb, []string{"a.txt", "b.txt", "c.txt", "d.txt"}, 1024)
	// Zip64 end record (with consistent 32-bit markers) and an archive comment.
	differential(t, "zip64 eocd", buildZip(t, []zentry{{name: "a.txt", data: []byte("x"), method: 8}}, zopts{zip64EOCD: true, comment: "PK\x05\x06 fake"}), []string{"a.txt"}, 10)
}

func TestMissingAndTruncated(t *testing.T) {
	text := "héllo wörld " + strings.Repeat("ü", 100)
	b := goZip(t, map[string]string{"plugin.yml": text})
	res := mustRead(t, b, []string{"fabric.mod.json", "plugin.yml", "paper-plugin.yml"}, 9)
	if fmt.Sprint(res.Missing) != "[fabric.mod.json paper-plugin.yml]" || len(res.Entries) != 1 {
		t.Fatalf("%+v", res)
	}
	e := res.Entries[0]
	if e.Complete || len(e.Data) != 9 || e.Size != uint64(len(text)) {
		t.Fatalf("%+v", e)
	}
	// 9 bytes end inside "ö": the partial rune is dropped, not replaced.
	got, truncated := Text(e.Data, e.Complete, 1000)
	if got != "héllo w" || !truncated {
		t.Fatalf("%q %v", got, truncated)
	}
	// Names match exactly and case-sensitively.
	res = mustRead(t, b, []string{"Plugin.yml", "plugin.yml ", "/plugin.yml"}, 10)
	if len(res.Entries) != 0 || len(res.Missing) != 3 {
		t.Fatalf("%+v", res)
	}
	// An empty archive is a zip without entries.
	res = mustRead(t, buildZip(t, nil, zopts{}), []string{"plugin.yml"}, 10)
	if len(res.Missing) != 1 {
		t.Fatal("empty zip")
	}
}

func TestZipBombIsBounded(t *testing.T) {
	const actual = 64 << 20
	comp := deflate(t, make([]byte, actual))
	for _, c := range []struct {
		name  string
		usize *uint64
		zip64 bool
	}{
		{"true size", nil, false},
		{"huge declared size (5 TiB, Zip64)", u64p(5 << 40), true},
	} {
		t.Run(c.name, func(t *testing.T) {
			b := buildZip(t, []zentry{{name: "bomb.txt", data: make([]byte, actual), method: 8, comp: comp, usize: c.usize, zip64: c.zip64}}, zopts{})
			cr := &countingReaderAt{r: bytes.NewReader(b)}
			start := time.Now()
			res, err := Read(context.Background(), cr, int64(len(b)), []string{"bomb.txt"}, 256*1024, DefaultLimits)
			if err != nil {
				t.Fatal(err)
			}
			e := res.Entries[0]
			if e.Complete || len(e.Data) != 256*1024 || e.Size != pick(c.usize, actual) {
				t.Fatalf("complete=%v len=%d size=%d", e.Complete, len(e.Data), e.Size)
			}
			// Only the tail, the directory and a few KiB of the compressed stream were read.
			if cr.n.Load() > 96<<10 || time.Since(start) > 5*time.Second {
				t.Fatalf("read %d bytes in %v for a %d-byte archive", cr.n.Load(), time.Since(start), len(b))
			}
		})
	}
	// A bomb that declares a small size is malformed (more data than declared).
	b := buildZip(t, []zentry{{name: "bomb.txt", data: make([]byte, actual), method: 8, comp: comp, usize: u64p(100)}}, zopts{})
	_, err := read(t, b, []string{"bomb.txt"}, 256*1024)
	expectErr(t, err, ErrNotZip)
}

func TestCentralDirectoryLimits(t *testing.T) {
	// A Zip64 end record claiming 10 million records: refused before anything is scanned.
	b := buildZip(t, []zentry{{name: "a.txt", data: []byte("a")}}, zopts{zip64EOCD: true, total: u64p(10_000_000)})
	cr := &countingReaderAt{r: bytes.NewReader(b)}
	_, err := Read(context.Background(), cr, int64(len(b)), []string{"a.txt"}, 10, DefaultLimits)
	expectErr(t, err, ErrTooLarge)
	if cr.n.Load() > int64(len(b))+100 {
		t.Fatalf("read %d bytes", cr.n.Load())
	}
	// A declared directory over 16 MiB.
	b = buildZip(t, []zentry{{name: "a.txt", data: []byte("a")}}, zopts{zip64EOCD: true, cdSize: u64p(16<<20 + 1)})
	_, err = read(t, b, []string{"a.txt"}, 10)
	expectErr(t, err, ErrTooLarge)

	many := func(n int) []zentry {
		es := make([]zentry, n)
		for i := range es {
			es[i] = zentry{name: fmt.Sprintf("f%d", i)}
		}
		return es
	}
	// 65 536 records are fine (the last one is readable)…
	es := many(65_536)
	es[len(es)-1].data = []byte("last")
	res := mustRead(t, buildZip(t, es, zopts{zip64EOCD: true}), []string{"f65535"}, 10)
	if string(res.Entries[0].Data) != "last" {
		t.Fatal("last record")
	}
	// …65 537 are not, even when the end record understates the count.
	b = buildZip(t, many(65_537), zopts{total: u64p(3)})
	_, err = read(t, b, []string{"f0"}, 10)
	expectErr(t, err, ErrTooLarge)

	// Records must exactly fill the declared directory (java.util.zip.ZipFile's rule) and the declared
	// size must lead to a record.
	two := []zentry{{name: "a.txt", data: []byte("a")}, {name: "b.txt", data: []byte("b")}}
	mustRead(t, buildZip(t, two, zopts{}), []string{"a.txt"}, 10)
	for name, o := range map[string]zopts{
		"short garbage after the records": {cdPad: make([]byte, 10)},
		"a non-record after the records":  {cdPad: make([]byte, 60)},
		"size one byte short":             {cdSize: u64p(2*cdHeaderLen + 10 - 1)},
		"size one byte long":              {cdSize: u64p(2*cdHeaderLen + 10 + 1)},
	} {
		_, err = read(t, buildZip(t, two, o), []string{"a.txt"}, 10)
		if !errors.Is(err, ErrNotZip) {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

func TestDuplicateNames(t *testing.T) {
	b := buildZip(t, []zentry{
		{name: "plugin.yml", data: []byte("name: First")},
		{name: "other.txt", data: []byte("x")},
		{name: "plugin.yml", data: []byte("name: Second")},
		{name: "dup.txt", data: []byte("1")},
		{name: "dup.txt", data: []byte("2")},
	}, zopts{})
	_, err := read(t, b, []string{"plugin.yml"}, 100)
	expectErr(t, err, ErrAmbiguous)
	// Duplicates of names that were not requested do not matter.
	res := mustRead(t, b, []string{"other.txt"}, 100)
	if string(res.Entries[0].Data) != "x" {
		t.Fatal("other.txt")
	}
}

func TestLyingHeaders(t *testing.T) {
	ok := []zentry{{name: "plugin.yml", data: []byte("name: Real"), method: 8}, {name: "z.txt", data: []byte("z")}}
	second := uint64(30 + 10 + len(deflate(t, []byte("name: Real")))) // local header of z.txt
	cdStart := second + 30 + 5 + 1
	cases := map[string]func(es []zentry, o *zopts){
		"local name differs":               func(es []zentry, o *zopts) { es[0].localName = strp("plugin.ymX") },
		"local name longer":                func(es []zentry, o *zopts) { es[0].localName = strp("plugin.yml.bak") },
		"offset points at the other entry": func(es []zentry, o *zopts) { es[0].offset = u64p(second) },
		"offset beyond the directory":      func(es []zentry, o *zopts) { es[0].offset = u64p(1 << 20) },
		"offset at the directory":          func(es []zentry, o *zopts) { es[1].offset = u64p(cdStart) },
		"header runs into the directory":   func(es []zentry, o *zopts) { es[1].offset = u64p(cdStart - 29) },
		"data overlaps the directory":      func(es []zentry, o *zopts) { es[1].csize = u64p(200); es[1].usize = u64p(200) },
		"encrypted (central directory)":    func(es []zentry, o *zopts) { es[0].flags = 1 },
		"encrypted (local header only)":    func(es []zentry, o *zopts) { es[0].localFlag = u16p(1) },
		"strong encryption":                func(es []zentry, o *zopts) { es[0].flags = 0x40 },
		"unsupported method (bzip2)":       func(es []zentry, o *zopts) { es[0].method = 12 },
		"CRC mismatch":                     func(es []zentry, o *zopts) { es[0].crc = u32p(12345) },
		"shorter than declared":            func(es []zentry, o *zopts) { es[0].usize = u64p(11) },
		"longer than declared":             func(es []zentry, o *zopts) { es[0].usize = u64p(3) },
		"stored with different sizes":      func(es []zentry, o *zopts) { es[1].usize = u64p(2) },
		"truncated deflate stream":         func(es []zentry, o *zopts) { c := deflate(t, []byte("name: Real")); es[0].comp = c[:len(c)-3] },
		"corrupt deflate stream":           func(es []zentry, o *zopts) { es[0].comp = []byte{0xff, 0xff, 0xff, 0xff} },
		"Zip64 marker without extra":       func(es []zentry, o *zopts) { es[0].zip64 = true; es[0].noZip64Ext = true },
		"size beyond 2^53 (Zip64 extra)":   func(es []zentry, o *zopts) { es[0].zip64 = true; es[0].usize = u64p(1 << 60) },
		"bad directory offset":             func(es []zentry, o *zopts) { o.cdOff = u64p(1 << 30); o.trailing = nil },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			es := append([]zentry{}, ok...)
			o := zopts{}
			mutate(es, &o)
			_, err := read(t, buildZip(t, es, o), []string{"plugin.yml", "z.txt"}, 1024)
			expectErr(t, err, ErrNotZip)
		})
	}
	// An unsupported method or encryption in an entry that was not requested is not looked at.
	es := append([]zentry{}, ok...)
	es[1].method, es[1].flags = 12, 1
	res := mustRead(t, buildZip(t, es, zopts{}), []string{"plugin.yml"}, 1024)
	if string(res.Entries[0].Data) != "name: Real" {
		t.Fatal("plugin.yml")
	}
}

func TestNotAZip(t *testing.T) {
	good := goZip(t, map[string]string{"plugin.yml": "name: x"})
	for name, b := range map[string][]byte{
		"empty":           {},
		"short":           []byte("PK"),
		"text":            []byte(strings.Repeat("this is not a jar\n", 100)),
		"truncated":       good[:len(good)-10],
		"end record only": good[len(good)-22:],
		"local headers only": func() []byte {
			i := bytes.Index(good, []byte("PK\x01\x02"))
			return good[:i]
		}(),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := read(t, b, []string{"plugin.yml"}, 10)
			expectErr(t, err, ErrNotZip)
		})
	}
}

func TestPrefixAndTrailingData(t *testing.T) {
	es := []zentry{{name: "plugin.yml", data: []byte("name: Stub"), method: 8}}
	// A launcher stub before the archive (offsets relative to the archive): Java and archive/zip read it.
	b := buildZip(t, es, zopts{prefix: []byte("#!/bin/sh\nexec java -jar \"$0\"\n")})
	differential(t, "stub", b, []string{"plugin.yml"}, 100)
	// Bytes after the end record: accepted when the directory and first local header are where the
	// record says (java.util.zip.ZipFile's rule).
	b = buildZip(t, es, zopts{trailing: bytes.Repeat([]byte{0}, 100)})
	res := mustRead(t, b, []string{"plugin.yml"}, 100)
	if string(res.Entries[0].Data) != "name: Stub" {
		t.Fatal("trailing")
	}
	// A comment containing a fake end record is skipped (its comment length does not reach EOF and
	// its directory is not plausible).
	b = buildZip(t, es, zopts{comment: "PK\x05\x06" + strings.Repeat("\x00", 18) + "tail"})
	res = mustRead(t, b, []string{"plugin.yml"}, 100)
	if string(res.Entries[0].Data) != "name: Stub" {
		t.Fatal("fake end record")
	}
}

// holeReaderAt fails reads that touch [from, to): EOF like a file truncated meanwhile, or EIO.
type holeReaderAt struct {
	r        io.ReaderAt
	from, to int64
	err      error
}

func (h holeReaderAt) ReadAt(p []byte, off int64) (int, error) {
	if off < h.to && off+int64(len(p)) > h.from {
		n := 0
		if off < h.from {
			n, _ = h.r.ReadAt(p[:h.from-off], off)
		}
		return n, h.err
	}
	return h.r.ReadAt(p, off)
}

func TestIOErrorsAndCancellation(t *testing.T) {
	// 200 KiB of incompressible data, so the end-record search does not cover the entry data.
	noise := make([]byte, 200<<10)
	rng := rand.New(rand.NewPCG(3, 4))
	for i := range noise {
		noise[i] = byte(rng.Uint32())
	}
	for _, method := range []uint16{0, 8} {
		b := buildZip(t, []zentry{{name: "plugin.yml", data: noise, method: method}}, zopts{})
		for _, hole := range []error{io.EOF, errors.New("input/output error")} {
			_, err := Read(context.Background(), holeReaderAt{bytes.NewReader(b), 1000, 2000, hole}, int64(len(b)), []string{"plugin.yml"}, 256<<10, DefaultLimits)
			var ioe *IOError
			if !errors.As(err, &ioe) || errors.Is(err, ErrNotZip) {
				t.Fatalf("method %d, %v: got %v", method, hole, err)
			}
		}
	}
	b := goZip(t, map[string]string{"plugin.yml": strings.Repeat("name: x\n", 1000)})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := Read(ctx, bytes.NewReader(b), int64(len(b)), []string{"plugin.yml"}, 1<<20, DefaultLimits)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
}

func TestText(t *testing.T) {
	cases := []struct {
		in       string
		complete bool
		max      int
		want     string
		trunc    bool
	}{
		{"plain\ttext\r\nline\n", true, 100, "plain\ttext\r\nline\n", false},
		{"bad \xff\xfe bytes", true, 100, "bad \uFFFD\uFFFD bytes", false},
		{"nul\x00 esc\x1b del\x7f c1\u0085 bell\a", true, 100, "nul\uFFFD esc\uFFFD del\uFFFD c1\uFFFD bell\uFFFD", false},
		{"surrogate \xed\xa0\x80", true, 100, "surrogate \uFFFD\uFFFD\uFFFD", false},
		{"<b>&</b>", true, 10, "<b>&</b>", false},            // 8 + 2 quotes
		{"<b>&</b>", true, 9, "<b>&</b"[:7], true},           // cut
		{`a"b`, true, 6, `a"b`, false},                       // 1+2+1 + quotes
		{`a"b`, true, 5, `a"`, true},                         // the escaped quote fits, "b" does not
		{`a"b`, true, 4, `a`, true},                          // the escaped quote does not fit
		{"x\u2028y", true, 10, "x\u2028y", false},            // U+2028 is sent as \u2028 (6)
		{"x\u2028y", true, 8, "x", true},                     // …so it does not fit in 8
		{"ü😀", true, 9, "ü😀", false},                         // 2 + 4 + quotes
		{"ü😀", true, 7, "ü", true},                           // never split a code point
		{"abc\xe2\x82", false, 100, "abc", true},             // incomplete trailing rune of a prefix is dropped
		{"abc\xe2\x82", true, 100, "abc\uFFFD\uFFFD", false}, // …but replaced in a complete entry
		{"", true, 1, "", false},
		{"x", true, 2, "", true},
		{"anything", false, 100, "anything", true}, // a prefix is always truncated
	}
	for _, c := range cases {
		got, trunc := Text([]byte(c.in), c.complete, c.max)
		if got != c.want || trunc != c.trunc {
			t.Errorf("Text(%q, %v, %d) = %q, %v; want %q, %v", c.in, c.complete, c.max, got, trunc, c.want, c.trunc)
		}
	}
	// Property: valid UTF-8, no control characters but TAB/LF/CR, encoded length within the budget.
	rng := rand.New(rand.NewPCG(1, 2))
	alphabet := []string{"a", "\"", "\\", "\n", "\x00", "\x1f", "\x7f", "\xc2\x85", "é", "€", "😀", "\u2028", "\xff", "\xe2\x82", "<", "&"}
	for i := 0; i < 5000; i++ {
		var sb strings.Builder
		for j := rng.IntN(64); j > 0; j-- {
			sb.WriteString(alphabet[rng.IntN(len(alphabet))])
		}
		max := 1 + rng.IntN(80)
		got, trunc := Text([]byte(sb.String()), rng.IntN(2) == 0, max)
		enc, _ := protocol.Marshal(got)
		if !utf8.ValidString(got) || (len(enc) > max && got != "") || (!trunc && len(got) > 0 && len(enc) > max) {
			t.Fatalf("Text(%q, max %d) = %q (%d encoded)", sb.String(), max, got, len(enc))
		}
		for _, r := range got {
			if unicode.IsControl(r) && r != '\t' && r != '\n' && r != '\r' {
				t.Fatalf("control character in %q", got)
			}
		}
	}
}
