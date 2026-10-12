package journal

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	id1 = "00000000-0000-4000-8000-000000000001"
	id2 = "00000000-0000-4000-8000-000000000002"
)

func TestJournalSurvivesRestartAndPrunes(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "commands.journal")
	now := time.UnixMilli(1760000000000)
	j, err := Open(p, now)
	if err != nil {
		t.Fatal(err)
	}
	if err := j.Append(id1, now.UnixMilli()+300_000); err != nil {
		t.Fatal(err)
	}
	if err := j.Append(id2, now.UnixMilli()+10_000); err != nil {
		t.Fatal(err)
	}
	j.Close()

	// Simulated crash: append a torn line.
	f, _ := os.OpenFile(p, os.O_WRONLY|os.O_APPEND, 0o600)
	f.WriteString(`{"id":"00000000-0000-4000-8000-0000`)
	f.Close()

	// Restart one minute later: id2 (expired + grace) is pruned, id1 is still a replay.
	j2, err := Open(p, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	defer j2.Close()
	if !j2.Contains(id1) {
		t.Fatal("id1 lost across restart")
	}
	if j2.Contains(id2) {
		t.Fatal("expired id2 not pruned")
	}
	if err := j2.Prune(now.Add(10 * time.Minute)); err != nil {
		t.Fatal(err)
	}
	if j2.Contains(id1) || j2.Len() != 0 {
		t.Fatal("id1 should be pruned after expiry + grace")
	}
}

// faultyFile wraps a real append handle and injects failures.
type faultyFile struct {
	f            *os.File
	partialWrite int // >0: write only this many bytes, then fail (once)
	failSync     bool
	failTruncate bool
}

func (ff *faultyFile) WriteAt(b []byte, off int64) (int, error) {
	if ff.partialWrite > 0 {
		n, _ := ff.f.WriteAt(b[:ff.partialWrite], off)
		ff.partialWrite = 0
		return n, errors.New("injected: disk full")
	}
	return ff.f.WriteAt(b, off)
}
func (ff *faultyFile) Sync() error {
	if ff.failSync {
		ff.failSync = false
		return errors.New("injected: fsync EIO")
	}
	return ff.f.Sync()
}
func (ff *faultyFile) Truncate(n int64) error {
	if ff.failTruncate {
		return errors.New("injected: truncate failed")
	}
	return ff.f.Truncate(n)
}
func (ff *faultyFile) Close() error { return ff.f.Close() }

const (
	idA = "00000000-0000-4000-8000-00000000000a"
	idB = "00000000-0000-4000-8000-00000000000b"
	idC = "00000000-0000-4000-8000-00000000000c"
	idD = "00000000-0000-4000-8000-00000000000d"
)

// injector opens real append handles wrapped in faultyFile; the next handle's faults are configurable.
type injector struct {
	current  *faultyFile
	failOpen bool
}

func (in *injector) open(p string) (file, error) {
	if in.failOpen {
		return nil, errors.New("injected: open failed")
	}
	f, err := os.OpenFile(p, os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	in.current = &faultyFile{f: f}
	return in.current, nil
}

func validLines(t *testing.T, p string) []string {
	t.Helper()
	b, _ := os.ReadFile(p)
	var ids []string
	for _, line := range strings.Split(strings.TrimSuffix(string(b), "\n"), "\n") {
		if line == "" {
			continue
		}
		var e entry
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			t.Fatalf("corrupt journal line %q", line)
		}
		ids = append(ids, e.ID)
	}
	return ids
}

func TestAppendFailureRollsBack(t *testing.T) {
	p := filepath.Join(t.TempDir(), "commands.journal")
	now := time.Now()
	in := &injector{}
	j, err := open(p, now, in.open)
	if err != nil {
		t.Fatal(err)
	}
	exp := now.UnixMilli() + 300_000
	if err := j.Append(idA, exp); err != nil {
		t.Fatal(err)
	}
	// Partial write: error returned, partial bytes truncated away, journal still usable.
	in.current.partialWrite = 10
	if err := j.Append(idB, exp); err == nil {
		t.Fatal("partial write reported success")
	}
	if j.Contains(idB) || j.Broken() != nil {
		t.Fatalf("failed id recorded or journal broken: %v", j.Broken())
	}
	if err := j.Append(idC, exp); err != nil {
		t.Fatalf("append after rolled-back failure: %v", err)
	}
	if got := strings.Join(validLines(t, p), ","); got != idA+","+idC {
		t.Fatalf("file content %q", got)
	}

	// fsync failure: roll back AND fail closed until the file is rewritten atomically.
	in.current.failSync = true
	if err := j.Append(idD, exp); err == nil {
		t.Fatal("fsync failure reported success")
	}
	if j.Broken() == nil || j.Contains(idD) {
		t.Fatal("journal must fail closed after an fsync failure")
	}
	// Repair is attempted on the next append; while it fails, appends keep failing (fail closed).
	in.failOpen = true
	if err := j.Append(idD, exp); err == nil {
		t.Fatal("append succeeded while the journal could not be repaired")
	}
	in.failOpen = false
	if err := j.Append(idD, exp); err != nil {
		t.Fatalf("append after repair: %v", err)
	}
	if j.Broken() != nil {
		t.Fatal("repair did not clear the broken state")
	}
	j.Close()
	if err := j.Append(idB, exp); err == nil {
		t.Fatal("append after close succeeded")
	}

	// Restart: exactly the successfully appended ids survive; nothing was glued together.
	j2, err := Open(p, now)
	if err != nil {
		t.Fatal(err)
	}
	defer j2.Close()
	for _, id := range []string{idA, idC, idD} {
		if !j2.Contains(id) {
			t.Fatalf("%s lost across restart", id)
		}
	}
	if j2.Contains(idB) || j2.Len() != 3 {
		t.Fatalf("unexpected entries after restart: %d", j2.Len())
	}
}

func TestRollbackFailureFailsClosedAndPruneRepairs(t *testing.T) {
	p := filepath.Join(t.TempDir(), "commands.journal")
	now := time.Now()
	in := &injector{}
	j, err := open(p, now, in.open)
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	exp := now.UnixMilli() + 300_000
	j.Append(idA, exp)
	in.current.partialWrite, in.current.failTruncate = 7, true
	if err := j.Append(idB, exp); err == nil || j.Broken() == nil {
		t.Fatal("rollback failure must fail closed")
	}
	// The periodic Prune repairs the file from memory (atomic rewrite drops the partial line).
	if err := j.Prune(now); err != nil {
		t.Fatal(err)
	}
	if j.Broken() != nil {
		t.Fatal("prune did not repair")
	}
	if got := strings.Join(validLines(t, p), ","); got != idA {
		t.Fatalf("after repair %q", got)
	}
	if err := j.Append(idC, exp); err != nil {
		t.Fatal(err)
	}
}

func TestOpenSalvagesGluedLine(t *testing.T) {
	p := filepath.Join(t.TempDir(), "commands.journal")
	exp := time.Now().UnixMilli() + 300_000
	glued := `{"id":"00000000-0000-4000-8000-0000{"id":"` + idC + `","expiresAt":` + strconv.FormatInt(exp, 10) + "}\n"
	os.WriteFile(p, []byte(glued), 0o600)
	j, err := Open(p, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	if !j.Contains(idC) {
		t.Fatal("entry glued to a torn prefix was not recovered")
	}
}
