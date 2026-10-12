package fsops

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/blockforge/node-agent/internal/protocol"
)

func TestCopyNames(t *testing.T) {
	cases := map[string]string{
		"server.properties": "server copy.properties",
		"world.tar.gz":      "world copy.tar.gz",
		".bashrc":           ".bashrc copy",
		"README":            "README copy",
		"a.b.c":             "a.b copy.c",
	}
	for in, want := range cases {
		if got := copyName(in, 1, false); got != want {
			t.Errorf("%s -> %q want %q", in, got, want)
		}
	}
	if got := copyName("server.properties", 3, false); got != "server copy 3.properties" {
		t.Fatal(got)
	}
	if got := copyName("my.world", 2, true); got != "my.world copy 2" {
		t.Fatal(got)
	}
}

func TestCopyFileAndDir(t *testing.T) {
	r, data, base := newRoot(t)
	os.WriteFile(filepath.Join(data, "server.properties"), []byte("a=1"), 0o640)
	p, err := r.Copy("server.properties")
	if err != nil || p != "server copy.properties" {
		t.Fatalf("%v %q", err, p)
	}
	p, _ = r.Copy("server.properties")
	if p != "server copy 2.properties" {
		t.Fatalf("second copy %q", p)
	}
	if b, _ := os.ReadFile(filepath.Join(data, "server copy 2.properties")); string(b) != "a=1" {
		t.Fatal("content")
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(filepath.Join(data, "server copy.properties")); fi.Mode().Perm() != 0o640 {
			t.Fatalf("mode %v", fi.Mode())
		}
	}
	os.MkdirAll(filepath.Join(data, "world", "region"), 0o755)
	os.WriteFile(filepath.Join(data, "world", "region", "r.mca"), []byte("RRRR"), 0o644)
	outside := filepath.Join(base, "outside")
	os.MkdirAll(outside, 0o755)
	os.WriteFile(filepath.Join(outside, "secret"), []byte("S"), 0o644)
	linked := os.Symlink(outside, filepath.Join(data, "world", "escape")) == nil
	p, err = r.Copy("world")
	if err != nil || p != "world copy" {
		t.Fatalf("dir copy %v %q", err, p)
	}
	if b, _ := os.ReadFile(filepath.Join(data, "world copy", "region", "r.mca")); string(b) != "RRRR" {
		t.Fatal("nested content")
	}
	if linked {
		if _, err := os.Lstat(filepath.Join(data, "world copy", "escape")); err == nil {
			t.Fatal("symlink copied (must be skipped)")
		}
	}
	_, err = r.Copy("")
	expectCode(t, err, protocol.CodePathForbidden)
	_, err = r.Copy("missing")
	expectCode(t, err, protocol.CodeNotFound)
}

func TestChmod(t *testing.T) {
	r, data, base := newRoot(t)
	os.WriteFile(filepath.Join(data, "start.sh"), []byte("#!/bin/sh"), 0o644)
	if err := r.Chmod("start.sh", 0o755); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(filepath.Join(data, "start.sh")); fi.Mode().Perm() != 0o755 {
			t.Fatalf("mode %v", fi.Mode())
		}
	}
	expectCode(t, r.Chmod("start.sh", 0o4755), protocol.CodeValidationFailed)
	expectCode(t, r.Chmod(".", 0o755), protocol.CodePathForbidden)
	os.WriteFile(filepath.Join(base, "victim"), []byte("v"), 0o600)
	if os.Symlink(filepath.Join(base, "victim"), filepath.Join(data, "link")) == nil {
		expectCode(t, r.Chmod("link", 0o777), protocol.CodePathForbidden)
		if fi, _ := os.Stat(filepath.Join(base, "victim")); runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600 {
			t.Fatal("chmod followed a symlink out of the sandbox")
		}
		os.Symlink("start.sh", filepath.Join(data, "inner"))
		expectCode(t, r.Chmod("inner", 0o700), protocol.CodePathForbidden)
	}
	if runtime.GOOS != "windows" {
		if err := mkfifo(filepath.Join(data, "pipe")); err == nil {
			expectCode(t, r.Chmod("pipe", 0o600), protocol.CodePathForbidden)
		}
	}
}

func TestFind(t *testing.T) {
	r, data, base := newRoot(t)
	for _, p := range []string{"world/level.dat", "world/Level.dat_old", "world_nether/level.dat", "logs/latest.log", "plugins/LevelSystem.jar"} {
		os.MkdirAll(filepath.Join(data, filepath.Dir(p)), 0o755)
		os.WriteFile(filepath.Join(data, p), []byte("x"), 0o644)
	}
	os.MkdirAll(filepath.Join(base, "outside"), 0o755)
	os.WriteFile(filepath.Join(base, "outside", "level.secret"), nil, 0o644)
	os.Symlink(filepath.Join(base, "outside"), filepath.Join(data, "lnk"))
	res, err := r.Find("", "LEVEL", 100)
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, m := range res.Matches {
		paths = append(paths, m.Path)
	}
	sort.Strings(paths)
	want := "plugins/LevelSystem.jar,world/Level.dat_old,world/level.dat,world_nether/level.dat"
	if strings.Join(paths, ",") != want || res.Truncated {
		t.Fatalf("matches %v truncated=%v", paths, res.Truncated)
	}
	res, _ = r.Find("", "level", 2)
	if len(res.Matches) != 2 || !res.Truncated {
		t.Fatalf("cap %d %v", len(res.Matches), res.Truncated)
	}
	res, _ = r.Find("world", "dat", 100)
	if len(res.Matches) != 2 {
		t.Fatalf("subdir %+v", res.Matches)
	}
	_, err = r.Find("world/level.dat", "x", 10)
	expectCode(t, err, protocol.CodeValidationFailed)
}

func listTarGz(t *testing.T, b []byte) map[string]string {
	gz, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	out := map[string]string{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		c, _ := io.ReadAll(tr)
		out[h.Name] = string(c)
	}
}

func TestCompress(t *testing.T) {
	r, data, base := newRoot(t)
	os.MkdirAll(filepath.Join(data, "world", "region"), 0o755)
	os.WriteFile(filepath.Join(data, "world", "level.dat"), []byte("LD"), 0o644)
	os.WriteFile(filepath.Join(data, "world", "region", "r.mca"), []byte("RR"), 0o644)
	os.WriteFile(filepath.Join(data, "eula.txt"), []byte("eula=true"), 0o644)
	os.WriteFile(filepath.Join(base, "secret"), []byte("TOP"), 0o644)
	os.Symlink(filepath.Join(base, "secret"), filepath.Join(data, "world", "leak"))
	now := time.Date(2026, 10, 12, 8, 30, 0, 0, time.UTC)
	res, err := r.Compress(protocol.FsCompressPayload{Root: "", Paths: []string{"world", "eula.txt"}, Format: "tar.gz", MaxTotalBytes: 1 << 20}, now)
	if err != nil {
		t.Fatal(err)
	}
	if res.Path != "archive-2026-10-12T083000Z.tar.gz" || res.Entries != 5 {
		t.Fatalf("result %+v", res)
	}
	b, _ := os.ReadFile(filepath.Join(data, res.Path))
	entries := listTarGz(t, b)
	if entries["world/level.dat"] != "LD" || entries["world/region/r.mca"] != "RR" || entries["eula.txt"] != "eula=true" {
		t.Fatalf("entries %v", entries)
	}
	if _, ok := entries["world/leak"]; ok {
		t.Fatal("symlink archived")
	}
	for name, c := range entries {
		if strings.Contains(c, "TOP") {
			t.Fatalf("content from outside the sandbox in %s", name)
		}
	}
	// Round trip through our own extractor.
	if _, err := r.Extract(protocol.FsExtractPayload{ArchivePath: res.Path, DestPath: "restored", MaxTotalBytes: 1 << 20, MaxEntries: 100}); err != nil {
		t.Fatalf("extract own archive: %v", err)
	}
	// Existing destination refused; zip with an explicit destPath inside a compressed dir.
	_, err = r.Compress(protocol.FsCompressPayload{Root: "", Paths: []string{"eula.txt"}, Format: "tar.gz", MaxTotalBytes: 1 << 20}, now)
	expectCode(t, err, protocol.CodeAlreadyExists)
	res, err = r.Compress(protocol.FsCompressPayload{Root: "world", Paths: []string{"region", "level.dat"}, Format: "zip", DestPath: "world/backup.zip", MaxTotalBytes: 1 << 20}, now)
	if err != nil {
		t.Fatal(err)
	}
	zb, _ := os.ReadFile(filepath.Join(data, "world", "backup.zip"))
	zr, _ := zip.NewReader(bytes.NewReader(zb), int64(len(zb)))
	names := []string{}
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	sort.Strings(names)
	if strings.Join(names, ",") != "level.dat,region/,region/r.mca" {
		t.Fatalf("zip names %v", names)
	}
	// Size bound: nothing is left behind.
	_, err = r.Compress(protocol.FsCompressPayload{Root: "", Paths: []string{"world"}, Format: "zip", DestPath: "big.zip", MaxTotalBytes: 3}, now)
	expectCode(t, err, protocol.CodeQuotaExceeded)
	if _, err := os.Stat(filepath.Join(data, "big.zip")); err == nil {
		t.Fatal("partial archive published")
	}
	noTemps := true
	filepath.Walk(data, func(p string, fi os.FileInfo, _ error) error {
		if fi != nil && strings.Contains(fi.Name(), ".bf-tmp-") {
			noTemps = false
		}
		return nil
	})
	if !noTemps {
		t.Fatal("temp file left behind")
	}
	_, err = r.Compress(protocol.FsCompressPayload{Root: "", Paths: []string{"../x"}, Format: "zip", MaxTotalBytes: 3}, now)
	expectCode(t, err, protocol.CodePathForbidden)
}
