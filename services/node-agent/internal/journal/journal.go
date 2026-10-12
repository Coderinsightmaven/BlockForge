// Package journal is the durable command seen-set (agent-protocol.md §4): every accepted command
// id is appended with its expiry to an fsync'd JSON-lines file before any side effect runs, so a
// replay after an agent restart is detected. Entries are pruned once they can no longer pass
// the expiry check (expiresAt + grace).
//
// Failure handling: a failed append is rolled back (truncate to the previous size + fsync) so a
// partial line can never be glued to the next entry. If the rollback fails, or an fsync fails
// (durability of the page cache is then unknown), the journal fails closed: every Append returns
// an error — and the executor rejects commands with a retryable INTERNAL error — until the file has
// been rewritten atomically from the in-memory set (attempted on the next Append and on Prune).
package journal

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/blockforge/node-agent/internal/fileutil"
	"github.com/blockforge/node-agent/internal/protocol"
)

type entry struct {
	ID        string `json:"id"`
	ExpiresAt int64  `json:"expiresAt"`
}

// file is the subset of *os.File the journal needs (injectable for failure tests).
type file interface {
	WriteAt(b []byte, off int64) (int, error)
	Sync() error
	Truncate(size int64) error
	Close() error
}

// Journal is safe for concurrent use.
type Journal struct {
	mu      sync.Mutex
	path    string
	f       file
	size    int64 // bytes of known-good content in the file
	broken  error // non-nil: fail closed until repaired
	closed  bool
	entries map[string]int64
	appends int

	openAppend func(path string) (file, error)
	now        func() time.Time
}

// osOpenAppend opens the journal for positional writes. O_APPEND is deliberately not used: entries
// are written with WriteAt at the known-good size, which keeps the rollback offset explicit and
// allows truncation on every platform (Windows refuses to truncate append-only handles).
func osOpenAppend(path string) (file, error) {
	return os.OpenFile(path, os.O_WRONLY, 0o600)
}

// Open loads the journal at path, drops expired entries, compacts the file and opens it for appending.
func Open(path string, now time.Time) (*Journal, error) {
	return open(path, now, osOpenAppend)
}

func open(path string, now time.Time, openAppend func(string) (file, error)) (*Journal, error) {
	j := &Journal{path: path, entries: map[string]int64{}, openAppend: openAppend, now: time.Now}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if f, err := os.Open(path); err == nil {
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 4096), 64*1024)
		for sc.Scan() {
			if e, ok := parseLine(sc.Bytes()); ok {
				j.entries[e.ID] = e.ExpiresAt
			}
		}
		f.Close()
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := j.compactLocked(now); err != nil {
		return nil, err
	}
	return j, nil
}

var entryStart = []byte(`{"id":`)

// parseLine decodes one entry. A torn prefix (crash mid-write by an older build) glued to a valid
// entry is skipped by retrying from the last entry start in the line.
func parseLine(b []byte) (entry, bool) {
	var e entry
	if json.Unmarshal(b, &e) == nil && protocol.IsUUID(e.ID) {
		return e, true
	}
	if i := bytes.LastIndex(b, entryStart); i > 0 {
		if json.Unmarshal(b[i:], &e) == nil && protocol.IsUUID(e.ID) {
			return e, true
		}
	}
	return entry{}, false
}

func live(expiresAt int64, now time.Time) bool {
	return now.UnixMilli() <= expiresAt+protocol.CommandExpiryGraceMs+1000
}

// compactLocked atomically rewrites the file from the in-memory set (live entries only), reopens
// it for append and clears the broken state on success.
func (j *Journal) compactLocked(now time.Time) error {
	var buf []byte
	for id, exp := range j.entries {
		if !live(exp, now) {
			delete(j.entries, id)
			continue
		}
		b, _ := json.Marshal(entry{ID: id, ExpiresAt: exp})
		buf = append(append(buf, b...), '\n')
	}
	if j.f != nil {
		j.f.Close()
		j.f = nil
	}
	if err := fileutil.WriteFileAtomic(j.path, buf, 0o600); err != nil {
		return err
	}
	f, err := j.openAppend(j.path)
	if err != nil {
		return err
	}
	j.f, j.size, j.broken, j.appends = f, int64(len(buf)), nil, 0
	return nil
}

// Contains reports whether id was recorded (and is not yet prunable).
func (j *Journal) Contains(id string) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	_, ok := j.entries[id]
	return ok
}

// Broken reports the fail-closed state (nil when healthy).
func (j *Journal) Broken() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.broken
}

// Append durably records id. It returns only after the line is fsync'd; on any error nothing is
// recorded and the file is left without a partial line (or the journal fails closed).
func (j *Journal) Append(id string, expiresAt int64) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return errors.New("journal closed")
	}
	if j.broken != nil || j.f == nil {
		cause := j.broken
		if cause == nil {
			cause = errors.New("journal file not open")
		}
		if err := j.compactLocked(j.now()); err != nil {
			if j.broken == nil {
				j.broken = cause
			}
			return fmt.Errorf("command journal unavailable (%v); repair failed: %w", cause, err)
		}
	}
	b, _ := json.Marshal(entry{ID: id, ExpiresAt: expiresAt})
	line := append(b, '\n')
	n, err := j.f.WriteAt(line, j.size)
	if err == nil && n != len(line) {
		err = io.ErrShortWrite
	}
	if err != nil {
		j.rollbackLocked(err)
		return fmt.Errorf("journal write: %w", err)
	}
	if err := j.f.Sync(); err != nil {
		// After a failed fsync the on-disk state is unknown: roll back and fail closed until the
		// file has been rewritten atomically.
		j.rollbackLocked(err)
		if j.broken == nil {
			j.broken = fmt.Errorf("fsync failed: %w", err)
		}
		return fmt.Errorf("journal fsync: %w", err)
	}
	j.size += int64(n)
	j.entries[id] = expiresAt
	j.appends++
	return nil
}

// rollbackLocked truncates the file back to the last known-good size; failure → fail closed.
func (j *Journal) rollbackLocked(cause error) {
	if err := j.f.Truncate(j.size); err != nil {
		j.broken = fmt.Errorf("rollback after %v failed: %w", cause, err)
		return
	}
	if err := j.f.Sync(); err != nil {
		j.broken = fmt.Errorf("rollback fsync after %v failed: %w", cause, err)
	}
}

// Prune drops expired entries and compacts the file when it has grown or is broken.
func (j *Journal) Prune(now time.Time) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return nil
	}
	expired := 0
	for _, exp := range j.entries {
		if !live(exp, now) {
			expired++
		}
	}
	if j.broken == nil && expired == 0 && j.appends < 1000 {
		return nil
	}
	return j.compactLocked(now)
}

// Len returns the number of tracked ids.
func (j *Journal) Len() int {
	j.mu.Lock()
	defer j.mu.Unlock()
	return len(j.entries)
}

// Close closes the file.
func (j *Journal) Close() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.closed = true
	if j.f == nil {
		return nil
	}
	err := j.f.Close()
	j.f = nil
	return err
}
