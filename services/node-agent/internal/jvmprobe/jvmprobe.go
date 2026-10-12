// Package jvmprobe embeds the BlockForge JVM probe jar built by services/jvm-probe/build.sh.
package jvmprobe

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"strings"
)

//go:embed jvm-probe.jar
var jar []byte

//go:embed jvm-probe.jar.sha256
var recordedSum string

// Jar returns the embedded probe jar.
func Jar() []byte { return jar }

// Sha256 returns the hex digest of the embedded jar.
func Sha256() string {
	s := sha256.Sum256(jar)
	return hex.EncodeToString(s[:])
}

// RecordedSha256 is the digest recorded by the build script.
func RecordedSha256() string {
	f := strings.Fields(recordedSum)
	if len(f) == 0 {
		return ""
	}
	return f[0]
}
