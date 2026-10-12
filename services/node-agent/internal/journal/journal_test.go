package journal

import (
	"os"
	"path/filepath"
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
