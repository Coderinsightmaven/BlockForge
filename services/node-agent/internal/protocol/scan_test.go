package protocol

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

// Mirrors packages/contracts/test/phase4b.test.ts ("agent fs.hash / jar.readEntries").
func TestExtensionScanSchemas(t *testing.T) {
	hash := func(extra string) string {
		return `{"workloadId":"` + wid + `","paths":["plugins/a.jar"],"algorithms":["sha512"],"maxBytesPerFile":1024` + extra + `}`
	}
	jar := func(extra string) string {
		return `{"workloadId":"` + wid + `","paths":["plugins/a.jar"],"entries":["plugin.yml"],"maxEntryBytes":262144,"maxJarBytes":1024` + extra + `}`
	}
	entries := func(names ...string) string {
		b, _ := json.Marshal(names)
		return strings.Replace(jar(""), `["plugin.yml"]`, string(b), 1)
	}
	cases := []struct {
		name, typ, payload string
		ok                 bool
	}{
		{"hash ok", CmdFsHash, hash(""), true},
		{"hash all algorithms", CmdFsHash, strings.Replace(hash(""), `["sha512"]`, `["sha1","sha256","sha512"]`, 1), true},
		{"hash duplicate algorithm", CmdFsHash, strings.Replace(hash(""), `["sha512"]`, `["sha1","sha1"]`, 1), false},
		{"hash md5", CmdFsHash, strings.Replace(hash(""), `["sha512"]`, `["md5"]`, 1), false},
		{"hash no algorithm", CmdFsHash, strings.Replace(hash(""), `["sha512"]`, `[]`, 1), false},
		{"hash maxBytesPerFile 2 GiB", CmdFsHash, strings.Replace(hash(""), `1024`, `2147483648`, 1), true},
		{"hash maxBytesPerFile 2 GiB + 1", CmdFsHash, strings.Replace(hash(""), `1024`, `2147483649`, 1), false},
		{"hash maxBytesPerFile 0", CmdFsHash, strings.Replace(hash(""), `1024`, `0`, 1), false},
		{"hash maxTotalBytes 64 GiB", CmdFsHash, hash(`,"maxTotalBytes":68719476736`), true},
		{"hash maxTotalBytes 64 GiB + 1", CmdFsHash, hash(`,"maxTotalBytes":68719476737`), false},
		{"hash maxTotalBytes 0", CmdFsHash, hash(`,"maxTotalBytes":0`), false},
		{"hash 512 paths", CmdFsHash, strings.Replace(hash(""), `["plugins/a.jar"]`, `[`+strings.TrimSuffix(strings.Repeat(`"a",`, 512), ",")+`]`, 1), true},
		{"hash 513 paths", CmdFsHash, strings.Replace(hash(""), `["plugins/a.jar"]`, `[`+strings.TrimSuffix(strings.Repeat(`"a",`, 513), ",")+`]`, 1), false},
		{"hash duplicate paths ok", CmdFsHash, strings.Replace(hash(""), `["plugins/a.jar"]`, `["a","a"]`, 1), true},
		{"hash traversal", CmdFsHash, strings.Replace(hash(""), `plugins/a.jar`, `../x`, 1), false},
		{"hash root ok (read-only)", CmdFsHash, strings.Replace(hash(""), `plugins/a.jar`, ``, 1), true},
		{"hash denylist", CmdFsHash, hash(`,"denylist":["*.jar"]`), true},
		{"jar ok", CmdJarReadEntries, jar(""), true},
		{"jar maxEntryBytes 256 KiB + 1", CmdJarReadEntries, strings.Replace(jar(""), `262144`, `262145`, 1), false},
		{"jar maxEntryBytes 0", CmdJarReadEntries, strings.Replace(jar(""), `262144`, `0`, 1), false},
		{"jar maxEntryBytes 63", CmdJarReadEntries, strings.Replace(jar(""), `262144`, `63`, 1), false},
		{"jar maxEntryBytes 64", CmdJarReadEntries, strings.Replace(jar(""), `262144`, `64`, 1), true},
		{"jar maxTotalBytes 8 MiB", CmdJarReadEntries, jar(`,"maxTotalBytes":8388608`), true},
		{"jar maxTotalBytes 8 MiB + 1", CmdJarReadEntries, jar(`,"maxTotalBytes":8388609`), false},
		{"jar maxJarBytes 2 GiB + 1", CmdJarReadEntries, strings.Replace(jar(""), `1024`, `2147483649`, 1), false},
		{"jar hash sha256", CmdJarReadEntries, jar(`,"hash":["sha256"]`), false},
		{"jar hash duplicate", CmdJarReadEntries, jar(`,"hash":["sha1","sha1"]`), false},
		{"jar hash both", CmdJarReadEntries, jar(`,"hash":["sha512","sha1"]`), true},
		{"jar hash empty", CmdJarReadEntries, jar(`,"hash":[]`), true},
		{"jar maxReadBytes 64 GiB", CmdJarReadEntries, jar(`,"maxReadBytes":68719476736`), true},
		{"jar maxReadBytes 64 GiB + 1", CmdJarReadEntries, jar(`,"maxReadBytes":68719476737`), false},
		{"jar maxReadBytes 0", CmdJarReadEntries, jar(`,"maxReadBytes":0`), false},
		{"jar maxReadBytes 1", CmdJarReadEntries, jar(`,"maxReadBytes":1`), true},
		{"jar duplicate entry", CmdJarReadEntries, entries("plugin.yml", "plugin.yml"), false},
		{"jar no entries", CmdJarReadEntries, entries(), false},
		{"jar 32 entries", CmdJarReadEntries, entries(manyNames(32)...), true},
		{"jar 33 entries", CmdJarReadEntries, entries(manyNames(33)...), false},
		{"jar 257 paths", CmdJarReadEntries, strings.Replace(jar(""), `["plugins/a.jar"]`, `[`+strings.TrimSuffix(strings.Repeat(`"a",`, 257), ",")+`]`, 1), false},
	}
	for _, n := range []string{"plugin.yml", "META-INF/mods.toml", "META-INF/neoforge.mods.toml", "a b/c.txt", "é/ü.txt", strings.Repeat("x", 255)} {
		cases = append(cases, struct {
			name, typ, payload string
			ok                 bool
		}{"entry name " + n, CmdJarReadEntries, entries(n), true})
	}
	for _, n := range []string{"", "../plugin.yml", "a/../b", "/plugin.yml", "a//b", "./a", "dir/", "a\\b", "a\x00b", "a\nb",
		"a\u007fb", "a\u0085b", "a\u009fb", "..", ".", strings.Repeat("x", 256), strings.Repeat("😀", 128)} {
		cases = append(cases, struct {
			name, typ, payload string
			ok                 bool
		}{"entry name " + strings.ToValidUTF8(n, "?"), CmdJarReadEntries, entries(n), false})
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, known, err := ParsePayload(c.typ, []byte(c.payload))
			if !known {
				t.Fatal("type unknown")
			}
			if (err == nil) != c.ok {
				t.Fatalf("ok=%v err=%v", c.ok, err)
			}
			if err != nil && err.Code != CodeValidationFailed {
				t.Fatalf("code %s", err.Code)
			}
		})
	}
	p, _, err := ParsePayload(CmdFsHash, []byte(hash("")))
	if err != nil || p.(*FsHashPayload).MaxTotalBytes != 16<<30 {
		t.Fatalf("fs.hash default: %v %+v", err, p)
	}
	p, _, err = ParsePayload(CmdJarReadEntries, []byte(jar("")))
	if err != nil {
		t.Fatal(err)
	}
	jp := p.(*JarReadEntriesPayload)
	if jp.MaxTotalBytes != 4<<20 || jp.Hash == nil || len(jp.Hash) != 0 || jp.MaxReadBytes != 8<<30 {
		t.Fatalf("jar.readEntries defaults %+v", jp)
	}
	if Commands[CmdFsHash].Mutating || Commands[CmdJarReadEntries].Mutating {
		t.Fatal("extension scans must not take the per-workload mutation lock")
	}
	if WorkloadIDOf(jp) != wid || WorkloadIDOf(&FsHashPayload{WorkloadID: wid}) != wid {
		t.Fatal("WorkloadIDOf")
	}
}

func manyNames(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = "META-INF/n" + strings.Repeat("x", i) + ".txt"
	}
	return out
}

// JSONStringLen must equal the size of what Marshal sends, for every code point (budgets rely on it).
func TestJSONStringLenMatchesEncoder(t *testing.T) {
	check := func(s string) {
		t.Helper()
		b, err := Marshal(s)
		if err != nil {
			t.Fatal(err)
		}
		if got := JSONStringLen(s); got != len(b) {
			t.Fatalf("JSONStringLen(%q)=%d, encoder %d (%s)", s, got, len(b), b)
		}
	}
	for r := rune(0); r < 0x10000; r++ {
		if r >= 0xD800 && r <= 0xDFFF {
			continue
		}
		check(string(r))
	}
	for _, r := range []rune{0x10000, 0x1F600, 0x10FFFF} {
		check(string(r))
	}
	for _, s := range []string{"", "<b>&amp;</b>", "a\"b\\c\n\r\t\b\f\x01\x1f\x7f", "line\u2028para\u2029", "😀é\u0085"} {
		check(s)
	}
	// Invalid UTF-8 (never in results: jarread.Text replaces it first): an upper bound.
	for _, s := range []string{"\xff\xfe", "\xe2\x82", "\xed\xa0\x80"} {
		b, _ := Marshal(s)
		if JSONStringLen(s) < len(b) {
			t.Fatalf("JSONStringLen(%q)=%d < encoder %d", s, JSONStringLen(s), len(b))
		}
	}
	if b, _ := Marshal("<&>"); string(b) != `"<&>"` {
		t.Fatalf("HTML escaped: %s", b)
	}
	if !utf8.ValidString(string(rune(0xFFFD))) {
		t.Fatal("replacement char")
	}
}
