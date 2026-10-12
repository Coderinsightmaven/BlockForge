package jvmprobe

import (
	"archive/zip"
	"bytes"
	"io"
	"strings"
	"testing"
)

func TestEmbeddedJarMatchesRecordedChecksum(t *testing.T) {
	if len(Jar()) == 0 || len(Jar()) > 64*1024 {
		t.Fatalf("jar size %d", len(Jar()))
	}
	if Sha256() != RecordedSha256() {
		t.Fatalf("embedded jar %s != recorded %s (rebuild with services/jvm-probe/build.sh)", Sha256(), RecordedSha256())
	}
	zr, err := zip.NewReader(bytes.NewReader(Jar()), int64(len(Jar())))
	if err != nil {
		t.Fatal(err)
	}
	var manifest string
	hasClass := false
	for _, f := range zr.File {
		if f.Name == "META-INF/MANIFEST.MF" {
			rc, _ := f.Open()
			b, _ := io.ReadAll(rc)
			rc.Close()
			manifest = string(b)
		}
		if f.Name == "io/blockforge/jvmprobe/Agent.class" {
			hasClass = true
			rc, _ := f.Open()
			hdr := make([]byte, 8)
			io.ReadFull(rc, hdr)
			rc.Close()
			// class file major version 52 = Java 8
			if hdr[6] != 0 || hdr[7] != 52 {
				t.Fatalf("class major version %d, want 52 (Java 8)", hdr[7])
			}
		}
	}
	if !hasClass || !strings.Contains(manifest, "Premain-Class: io.blockforge.jvmprobe.Agent") {
		t.Fatalf("manifest %q class %v", manifest, hasClass)
	}
}
