//go:build linux

package backup

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
)

func init() {
	failOpen = func(t *testing.T) func() {
		var orig syscall.Rlimit
		if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &orig); err != nil {
			t.Fatal(err)
		}
		low := orig
		low.Cur = 3 // only stdin/stdout/stderr: the next open fails with EMFILE
		if err := syscall.Setrlimit(syscall.RLIMIT_NOFILE, &low); err != nil {
			t.Fatal(err)
		}
		return func() { syscall.Setrlimit(syscall.RLIMIT_NOFILE, &orig) }
	}
}

func openFds(t *testing.T) int {
	t.Helper()
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		t.Skip("/proc unavailable")
	}
	return len(entries)
}

// TestCreateClosesEachFile: with the fd limit only a little above what the process already uses, a
// backup of many files succeeds, i.e. every file is closed before the next is opened (review #2).
func TestCreateClosesEachFile(t *testing.T) {
	m, data := newManager(t)
	for i := 0; i < 600; i++ {
		write(t, data, fmt.Sprintf("d%d/f%03d.txt", i%5, i), "x", 0o644)
	}
	var orig syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &orig); err != nil {
		t.Fatal(err)
	}
	low := orig
	low.Cur = uint64(openFds(t) + 24)
	if err := syscall.Setrlimit(syscall.RLIMIT_NOFILE, &low); err != nil {
		t.Fatal(err)
	}
	res, err := m.Create(context.Background(), createPayload(), nil)
	syscall.Setrlimit(syscall.RLIMIT_NOFILE, &orig)
	if err != nil {
		t.Fatalf("backup under a tight fd limit (%d): %v", low.Cur, err)
	}
	if res.Files != 600 {
		t.Fatalf("files %d", res.Files)
	}
}

// TestCreateSymlinkSwapRace is the exploit of review #1 as a real race: while backups run, another
// goroutine keeps replacing a.dat (and the directory world) with symlinks into the agent area and
// back. No archive may ever contain agent-area content, whatever the interleaving.
func TestCreateSymlinkSwapRace(t *testing.T) {
	m, data := newManager(t)
	write(t, data, ".blockforge/secret.txt", "AGENT-SECRET", 0o644)
	write(t, data, ".blockforge/inner/deep.txt", "AGENT-SECRET-DEEP", 0o644)
	write(t, data, "a.dat", "public", 0o644)
	write(t, data, "world/level.dat", "LEVEL", 0o644)
	for i := 0; i < 50; i++ {
		write(t, data, fmt.Sprintf("pad/f%02d", i), "pad", 0o644) // widen the window between readdir and open
	}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	var flips atomic.Int64
	wg.Add(1)
	go func() {
		defer wg.Done()
		aLink, aFile := filepath.Join(data, ".a.link"), filepath.Join(data, ".a.file")
		wLink, wDir := filepath.Join(data, ".w.link"), filepath.Join(data, ".w.dir")
		for {
			select {
			case <-stop:
				return
			default:
			}
			os.Symlink(".blockforge/secret.txt", aLink)
			os.Rename(aLink, filepath.Join(data, "a.dat")) // atomic: file → symlink
			os.Symlink(".blockforge", wLink)
			os.RemoveAll(wDir)
			os.Rename(filepath.Join(data, "world"), wDir)
			os.Rename(wLink, filepath.Join(data, "world")) // directory → symlink
			os.WriteFile(aFile, []byte("public"), 0o644)
			os.Rename(aFile, filepath.Join(data, "a.dat")) // symlink → file
			os.Remove(filepath.Join(data, "world"))
			os.Rename(wDir, filepath.Join(data, "world")) // symlink → directory
			flips.Add(1)
		}
	}()
	defer func() { close(stop); wg.Wait() }()
	p := createPayload()
	p.Ignore = nil
	archived := 0
	for i := 0; i < 40; i++ {
		p.BackupID = newBackupID(100 + i)
		if _, err := m.Create(context.Background(), p, nil); err != nil {
			t.Fatalf("backup %d: %v", i, err)
		}
		for name, v := range listArchive(t, m.ArchivePath(wid, p.BackupID)) {
			if strings.Contains(v, "AGENT-SECRET") || strings.HasPrefix(name, ".blockforge") || strings.Contains(name, "deep.txt") ||
				strings.Contains(name, "secret") {
				t.Fatalf("backup %d archived agent-area content as %s", i, name)
			}
			if name == "a.dat" || name == "world/level.dat" {
				archived++
			}
		}
	}
	t.Logf("%d swaps during 40 backups; a.dat/world archived %d times (as regular content)", flips.Load(), archived)
}
