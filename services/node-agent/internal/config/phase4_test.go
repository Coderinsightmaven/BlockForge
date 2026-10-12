package config

import "testing"

func TestPhase4AllowlistDefaults(t *testing.T) {
	al, _ := NewImageAllowlist(DefaultImageAllowlist)
	for _, img := range []string{"ghcr.io/pelican-eggs/yolks:java_21", "ghcr.io/pelican-eggs/installers:debian",
		"ghcr.io/pelican-eggs/steamcmd:debian", "ghcr.io/parkervcp/steamcmd:proton"} {
		if !al.Allowed(img) {
			t.Errorf("%s not allowed by default", img)
		}
	}
	// Both earlier default lists are upgraded; a customised list is kept.
	for _, prev := range previousDefaultImageAllowlists {
		c := &Config{ImageAllowlist: append([]string(nil), prev...)}
		c.ApplyDefaults()
		if !equalStrings(c.ImageAllowlist, DefaultImageAllowlist) {
			t.Fatalf("previous default %v not upgraded: %v", prev, c.ImageAllowlist)
		}
	}
	custom := []string{"eclipse-temurin:*", "ghcr.io/pterodactyl/yolks:*"}
	c := &Config{ImageAllowlist: custom}
	c.ApplyDefaults()
	if !equalStrings(c.ImageAllowlist, custom) {
		t.Fatalf("custom list changed: %v", c.ImageAllowlist)
	}
	if c.BackupFreeReserveBytes != 2<<30 || c.BackupMaxEntries != 2_000_000 || c.BackupMaxUncompressedBytes != 256<<30 {
		t.Fatalf("backup defaults: %d %d %d", c.BackupFreeReserveBytes, c.BackupMaxEntries, c.BackupMaxUncompressedBytes)
	}
}
