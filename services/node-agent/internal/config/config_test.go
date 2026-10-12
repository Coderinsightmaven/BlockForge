package config

import (
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestControlPlaneURLPolicy(t *testing.T) {
	cases := []struct {
		url      string
		insecure bool
		ok       bool
	}{
		{"https://cp.example.com", false, true},
		{"https://cp.example.com/base/", false, true},
		{"http://cp.example.com", false, false},
		{"http://cp.example.com", true, false}, // flag only covers loopback/dev hosts
		{"http://10.0.0.5:8080", true, false},
		{"http://localhost:8080", false, false},
		{"http://localhost:8080", true, true},
		{"http://127.0.0.1:18080", true, true},
		{"http://[::1]:8080", true, true},
		{"http://host.docker.internal:8080", true, true},
		{"http://HOST.DOCKER.INTERNAL:8080", true, true},
		{"http://127.0.0.2:8080", true, false},
		{"http://localhost.evil.com", true, false},
		{"https://user:pw@cp.example.com", false, false},
		{"ftp://cp.example.com", true, false},
		{"https://cp.example.com/?x=1", false, false},
	}
	for _, c := range cases {
		_, err := ValidateControlPlaneURL(c.url, c.insecure)
		if (err == nil) != c.ok {
			t.Errorf("%s insecure=%v: ok=%v err=%v", c.url, c.insecure, c.ok, err)
		}
	}
	u, _ := ValidateControlPlaneURL("https://cp.example.com/base/", false)
	if got := WebSocketURL(u); got != "wss://cp.example.com/base/agent/v1/connect" {
		t.Fatalf("ws url %s", got)
	}
	u, _ = ValidateControlPlaneURL("http://127.0.0.1:18080", true)
	if got := WebSocketURL(u); got != "ws://127.0.0.1:18080/agent/v1/connect" {
		t.Fatalf("ws url %s", got)
	}
	if got := Endpoint(u, "/agent/v1/transfers/x"); got != "http://127.0.0.1:18080/agent/v1/transfers/x" {
		t.Fatalf("endpoint %s", got)
	}
}

func TestImageAllowlist(t *testing.T) {
	al, err := NewImageAllowlist([]string{"eclipse-temurin:*", "ghcr.io/acme/mc:1.2", "alpine:3.22"})
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]bool{
		"eclipse-temurin:21-jre":                         true,
		"docker.io/library/eclipse-temurin:21-jre":       true,
		"index.docker.io/library/eclipse-temurin:25-jre": true,
		"library/eclipse-temurin:17":                     true,
		"eclipse-temurin":                                false, // no tag
		"eclipse-temurin@sha256:" + repeat("a", 64):      false, // digest, not tag
		"eclipse-temurin:21@sha256:" + repeat("a", 64):   false,
		"eclipse-temurin-evil:21":                        false,
		"evil/eclipse-temurin:21":                        false,
		"ghcr.io/eclipse-temurin:21":                     false,
		"ghcr.io/acme/mc:1.2":                            true,
		"ghcr.io/acme/mc:1.3":                            false,
		"alpine:3.22":                                    true,
		"docker.io/library/alpine:3.22":                  true,
		"alpine:3.21":                                    false,
		"registry.local:5000/eclipse-temurin:21":         false,
		"Eclipse-Temurin:21":                             false,
		"":                                               false,
	}
	for img, want := range cases {
		if got := al.Allowed(img); got != want {
			t.Errorf("%q: got %v want %v", img, got, want)
		}
	}
	if _, err := NewImageAllowlist([]string{"eclipse-*:21"}); err == nil {
		t.Fatal("mid-string wildcard must be rejected")
	}
	if _, err := NewImageAllowlist([]string{"registry:5000/x:*"}); err == nil {
		t.Fatal("registry with port must be rejected")
	}
}

func repeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}

func TestHostAllowlist(t *testing.T) {
	al := NewHostAllowlist(append(DefaultDownloadHosts, "*.example.org", "127.0.0.1:8443"))
	cases := map[string]bool{
		"https://fill-data.papermc.io/v1/objects/x.jar": true,
		"https://FILL-DATA.papermc.io/x":                true,
		"https://fill-data.papermc.io:443/x":            true,
		"https://fill-data.papermc.io:8443/x":           false,
		"http://fill-data.papermc.io/x":                 false,
		"https://evil.com/x":                            false,
		"https://fill-data.papermc.io.evil.com/x":       false,
		"https://a.example.org/x":                       true,
		"https://example.org/x":                         false,
		"https://127.0.0.1:8443/x":                      true,
		"https://127.0.0.1/x":                           false,
		"https://u:p@fill-data.papermc.io/x":            false,
	}
	for raw, want := range cases {
		u, _ := url.Parse(raw)
		if got := al.Allowed(u) == nil; got != want {
			t.Errorf("%s: got %v want %v", raw, got, want)
		}
	}
}

func TestConfigSaveLoad(t *testing.T) {
	dir := t.TempDir()
	c := &Config{
		NodeID:                 "6f1c2b9a-4d3e-4f5a-9b8c-7d6e5f4a3b2c",
		ControlPlaneURL:        "http://127.0.0.1:8080",
		InsecureAllowHTTP:      true,
		ControlPlaneSigningKey: "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w",
		DataRoot:               filepath.Join(dir, "data"),
		WorkloadUID:            1000,
		WorkloadGID:            1000,
	}
	if runtime.GOOS == "windows" {
		c.DataRoot = `C:\bf-data`
	}
	c.ApplyDefaults()
	if err := c.Save(dir); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(dir, ConfigFile))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600 {
		t.Fatalf("config mode %v", fi.Mode().Perm())
	}
	got, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got.NodeID != c.NodeID || len(got.DownloadHostAllowlist) != len(DefaultDownloadHosts) {
		t.Fatalf("loaded %+v", got)
	}
	c.ControlPlaneURL = "http://10.0.0.1:8080"
	_ = c.Save(dir)
	if _, err := Load(dir); err == nil {
		t.Fatal("non-loopback http accepted on load")
	}
}

func TestPhase3Defaults(t *testing.T) {
	al, err := NewImageAllowlist(DefaultImageAllowlist)
	if err != nil {
		t.Fatal(err)
	}
	for img, want := range map[string]bool{
		"ghcr.io/pterodactyl/yolks:java_21":     true,
		"ghcr.io/pterodactyl/installers:alpine": true,
		"ghcr.io/parkervcp/yolks:debian":        true,
		"ghcr.io/parkervcp/installers:debian":   true,
		"eclipse-temurin:25-jre":                true,
		"ghcr.io/pterodactyl/yolks":             false, // no tag
		"ghcr.io/pterodactyl/evil:latest":       false,
		"ghcr.io/pterodactyl/yolks/sub:x":       false,
		"docker.io/pterodactyl/yolks:java_21":   false,
		"GHCR.IO/pterodactyl/yolks:java_21":     true, // registry host is case-insensitive
	} {
		if al.Allowed(img) != want {
			t.Errorf("%s: want %v", img, want)
		}
	}
	// A config written by an older agent with the old default list is upgraded; custom lists are kept.
	c := &Config{ImageAllowlist: []string{"eclipse-temurin:*"}}
	c.ApplyDefaults()
	if len(c.ImageAllowlist) != len(DefaultImageAllowlist) {
		t.Fatalf("legacy default not upgraded: %v", c.ImageAllowlist)
	}
	c = &Config{ImageAllowlist: []string{"eclipse-temurin:*", "alpine:3.22"}}
	c.ApplyDefaults()
	if len(c.ImageAllowlist) != 2 {
		t.Fatalf("custom list changed: %v", c.ImageAllowlist)
	}
	if !c.SFTP.On() || c.SFTP.Listen != "0.0.0.0:2022" || c.ArtifactCacheMaxBytes != 10<<30 {
		t.Fatalf("sftp/cache defaults %+v %d", c.SFTP, c.ArtifactCacheMaxBytes)
	}
	off := false
	c.SFTP.Enabled = &off
	if c.SFTP.On() {
		t.Fatal("sftp disable")
	}
}
