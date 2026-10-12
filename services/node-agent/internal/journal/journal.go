// Package journal is the durable command seen-set (agent-protocol.md §4): every accepted command
// id is appended with its expiry to an fsync'd JSON-lines file before any side effect runs, so a
// replay after an agent restart is detected. Entries are pruned once they can no longer pass
// the expiry check (expiresAt + grace).
package journal

import (
	"bufio"
	"encoding/json"
	"errors"
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

// Journal is safe for concurrent use.
type Journal struct {
	mu      sync.Mutex
	path    string
	f       *os.File
	entries map[string]int64
	appends int
}

// Open loads the journal at path, drops expired entries, compacts the file and opens it for appending.
func Open(path string, now time.Time) (*Journal, error) {
	j := &Journal{path: path, entries: map[string]int64{}}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if f, err := os.Open(path); err == nil {
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 4096), 4096)
		for sc.Scan() {
			var e entry
			// A torn final line (crash mid-write) is ignored.
			if json.Unmarshal(sc.Bytes(), &e) == nil && protocol.IsUUID(e.ID) {
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

func live(expiresAt int64, now time.Time) bool {
	return now.UnixMilli() <= expiresAt+protocol.CommandExpiryGraceMs+1000
}

// compactLocked rewrites the file with live entries only and reopens it for append.
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
	f, err := os.OpenFile(j.path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	j.f = f
	j.appends = 0
	return nil
}

// Contains reports whether id was recorded (and is not yet prunable).
func (j *Journal) Contains(id string) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	_, ok := j.entries[id]
	return ok
}

// Append durably records id. It returns only after the line is fsync'd.
func (j *Journal) Append(id string, expiresAt int64) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.f == nil {
		return errors.New("journal closed")
	}
	b, _ := json.Marshal(entry{ID: id, ExpiresAt: expiresAt})
	if _, err := j.f.Write(append(b, '\n')); err != nil {
		return err
	}
	if err := j.f.Sync(); err != nil {
		return err
	}
	j.entries[id] = expiresAt
	j.appends++
	return nil
}

// Prune drops expired entries and compacts the file when it has grown.
func (j *Journal) Prune(now time.Time) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.f == nil {
		return nil
	}
	expired := 0
	for _, exp := range j.entries {
		if !live(exp, now) {
			expired++
		}
	}
	if expired == 0 && j.appends < 1000 {
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
	if j.f == nil {
		return nil
	}
	err := j.f.Close()
	j.f = nil
	return err
}
