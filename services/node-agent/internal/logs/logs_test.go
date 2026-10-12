package logs

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/blockforge/node-agent/internal/protocol"
)

func TestTokenBucket(t *testing.T) {
	t0 := time.Unix(1000, 0)
	b := NewTokenBucket(200, 2000, t0)
	allowed := 0
	for i := 0; i < 5000; i++ {
		if b.Allow(t0) {
			allowed++
		}
	}
	if allowed != 2000 {
		t.Fatalf("burst: %d", allowed)
	}
	// One second later exactly 200 more.
	allowed = 0
	t1 := t0.Add(time.Second)
	for i := 0; i < 1000; i++ {
		if b.Allow(t1) {
			allowed++
		}
	}
	if allowed != 200 {
		t.Fatalf("refill: %d", allowed)
	}
	// Refill is capped at burst.
	t2 := t1.Add(time.Hour)
	allowed = 0
	for i := 0; i < 3000; i++ {
		if b.Allow(t2) {
			allowed++
		}
	}
	if allowed != 2000 {
		t.Fatalf("cap: %d", allowed)
	}
}

func TestRing(t *testing.T) {
	r := NewRing(3)
	for i := 1; i <= 5; i++ {
		r.Add(protocol.LogLine{TS: int64(i), Line: fmt.Sprint(i)})
	}
	got := r.Tail(10, -1)
	if len(got) != 3 || got[0].Line != "3" || got[2].Line != "5" {
		t.Fatalf("tail %+v", got)
	}
	if got := r.Tail(2, -1); got[0].Line != "4" || got[1].Line != "5" {
		t.Fatalf("tail2 %+v", got)
	}
	if got := r.Tail(10, 5); len(got) != 1 || got[0].Line != "5" {
		t.Fatalf("since %+v", got)
	}
}

func TestLineWriter(t *testing.T) {
	var lines []string
	w := NewLineWriter(10, func(s string) { lines = append(lines, s) })
	w.Write([]byte("hello\r\nwor"))
	w.Write([]byte("ld\n"))
	w.Write([]byte(strings.Repeat("x", 25) + "\nnext\n"))
	w.Write([]byte(strings.Repeat("y", 12)))
	w.Write([]byte(strings.Repeat("y", 12)))
	w.Write([]byte("tail\nend"))
	w.Flush()
	want := []string{"hello", "world", strings.Repeat("x", 10), "next", strings.Repeat("y", 10), "end"}
	if strings.Join(lines, "|") != strings.Join(want, "|") {
		t.Fatalf("lines %q", lines)
	}
}

func TestTruncate(t *testing.T) {
	s := strings.Repeat("é", 5000) // 10000 bytes
	got := Truncate(s, protocol.LogLineMaxBytes)
	if len(got) > protocol.LogLineMaxBytes || !strings.HasPrefix(s, got) || len(got) != 8192 {
		t.Fatalf("len %d", len(got))
	}
	if got := Truncate("ab\xffcd", 100); got != "ab�cd" {
		t.Fatalf("invalid utf8: %q", got)
	}
}

func TestManagerRateLimitAndBatching(t *testing.T) {
	var frames []protocol.LogsFrame
	m := NewManager(func(f protocol.LogsFrame) { frames = append(frames, f) })
	now := time.Unix(1000, 0)
	m.now = func() time.Time { return now }
	const id = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
	for i := 0; i < 2500; i++ {
		m.Ingest(id, protocol.LogLine{TS: int64(i), Stream: "stdout", Line: fmt.Sprintf("line %d", i)})
	}
	m.Flush()
	total := 0
	var dropped int64
	for _, f := range frames {
		total += len(f.Lines)
		if f.Dropped != nil {
			dropped += *f.Dropped
		}
		if f.WorkloadID != id || f.T != "logs" {
			t.Fatal("frame header")
		}
	}
	if total != 2000 || dropped != 500 {
		t.Fatalf("forwarded %d dropped %d", total, dropped)
	}
	// The ring still has the most recent 5000 (here 2500) lines, including dropped ones.
	tail, ok := m.Tail(id, 5000, -1)
	if !ok || len(tail) != 2500 || tail[2499].Line != "line 2499" {
		t.Fatalf("tail %d", len(tail))
	}
	frames = nil
	m.Flush()
	if len(frames) != 0 {
		t.Fatal("empty flush emitted frames")
	}
	now = now.Add(time.Second)
	m.Ingest(id, protocol.LogLine{TS: 1, Stream: "stderr", Line: strings.Repeat("z", 20000)})
	m.Flush()
	if len(frames) != 1 || len(frames[0].Lines[0].Line) != protocol.LogLineMaxBytes {
		t.Fatalf("truncation in manager")
	}
	if _, ok := m.Tail("00000000-0000-4000-8000-000000000000", 10, -1); ok {
		t.Fatal("unknown workload reported buffered lines")
	}
}
