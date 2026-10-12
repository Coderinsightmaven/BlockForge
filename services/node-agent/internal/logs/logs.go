// Package logs handles workload stdout/stderr: line splitting with 8 KiB truncation, a per-workload
// token bucket (200 lines/s, burst 2000), a 5000-line ring buffer backing workload.logs.tail, and
// batching into `logs` frames every ~250 ms with a dropped-line counter.
package logs

import (
	"bytes"
	"context"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/blockforge/node-agent/internal/protocol"
)

// Defaults from the protocol.
const (
	RingSize      = 5000
	FlushInterval = 250 * time.Millisecond
	maxFrameLines = 5000
	maxFrameBytes = 1 << 20
)

// TokenBucket is a classic token bucket with an injectable clock.
type TokenBucket struct {
	rate, burst float64
	tokens      float64
	last        time.Time
}

// NewTokenBucket starts full.
func NewTokenBucket(rate, burst float64, now time.Time) *TokenBucket {
	return &TokenBucket{rate: rate, burst: burst, tokens: burst, last: now}
}

// Allow consumes one token if available.
func (b *TokenBucket) Allow(now time.Time) bool {
	if now.After(b.last) {
		b.tokens += now.Sub(b.last).Seconds() * b.rate
		if b.tokens > b.burst {
			b.tokens = b.burst
		}
		b.last = now
	}
	if b.tokens >= 1 {
		b.tokens--
		return true
	}
	return false
}

// Ring is a fixed-size ring of log lines.
type Ring struct {
	buf   []protocol.LogLine
	start int
	size  int
}

// NewRing creates a ring holding at most size lines (allocated lazily).
func NewRing(size int) *Ring { return &Ring{size: size} }

// Add appends a line, evicting the oldest when full.
func (r *Ring) Add(l protocol.LogLine) {
	if len(r.buf) < r.size {
		r.buf = append(r.buf, l)
		return
	}
	r.buf[r.start] = l
	r.start = (r.start + 1) % r.size
}

// Len is the number of stored lines.
func (r *Ring) Len() int { return len(r.buf) }

// Tail returns up to n most recent lines with ts >= since (since < 0 = no filter), oldest first.
func (r *Ring) Tail(n int, since int64) []protocol.LogLine {
	out := make([]protocol.LogLine, 0, min(n, len(r.buf)))
	for i := len(r.buf) - 1; i >= 0 && len(out) < n; i-- {
		l := r.buf[(r.start+i)%len(r.buf)]
		if since >= 0 && l.TS < since {
			break
		}
		out = append(out, l)
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

// Truncate sanitises invalid UTF-8 and cuts a line to max bytes at a rune boundary.
func Truncate(s string, max int) string {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "�")
	}
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// LineWriter splits a byte stream into lines and hands each to emit. Lines longer than the limit
// are truncated and the remainder until the next newline is discarded (bounded memory).
type LineWriter struct {
	buf     []byte
	discard bool
	emit    func(line string)
	limit   int
}

// NewLineWriter creates a splitter.
func NewLineWriter(limit int, emit func(string)) *LineWriter {
	return &LineWriter{emit: emit, limit: limit}
}

func (w *LineWriter) Write(p []byte) (int, error) {
	n := len(p)
	for len(p) > 0 {
		i := bytes.IndexByte(p, '\n')
		var chunk []byte
		if i < 0 {
			chunk, p = p, nil
		} else {
			chunk, p = p[:i], p[i+1:]
		}
		if !w.discard {
			room := w.limit - len(w.buf)
			if len(chunk) > room {
				w.buf = append(w.buf, chunk[:max(room, 0)]...)
				w.discard = true
			} else {
				w.buf = append(w.buf, chunk...)
			}
		}
		if i >= 0 {
			w.flushLine()
		} else if w.discard && len(w.buf) > 0 {
			// Emit the truncated prefix now; drop everything until the next newline.
			w.flushLine()
			w.discard = true
		}
	}
	return n, nil
}

func (w *LineWriter) flushLine() {
	line := strings.TrimSuffix(string(w.buf), "\r")
	w.buf = w.buf[:0]
	wasDiscard := w.discard
	w.discard = false
	if line == "" && wasDiscard {
		return
	}
	w.emit(line)
}

// Flush emits a pending partial line (call at stream end).
func (w *LineWriter) Flush() {
	if len(w.buf) > 0 {
		w.flushLine()
	}
	w.discard = false
}

type stream struct {
	ring    *Ring
	bucket  *TokenBucket
	pending []protocol.LogLine
	bytes   int
	dropped int64
}

// Manager owns per-workload log state and emits batched frames.
type Manager struct {
	mu      sync.Mutex
	streams map[string]*stream
	emit    func(protocol.LogsFrame)
	now     func() time.Time
}

// NewManager creates a manager; emit is called from the flush loop.
func NewManager(emit func(protocol.LogsFrame)) *Manager {
	return &Manager{streams: map[string]*stream{}, emit: emit, now: time.Now}
}

func (m *Manager) get(id string) *stream {
	s := m.streams[id]
	if s == nil {
		s = &stream{ring: NewRing(RingSize), bucket: NewTokenBucket(protocol.LogLinesPerSecond, protocol.LogBurstLines, m.now())}
		m.streams[id] = s
	}
	return s
}

// Ingest records one line: always kept in the ring, forwarded only if the rate limit allows.
func (m *Manager) Ingest(workloadID string, l protocol.LogLine) {
	l.Line = Truncate(l.Line, protocol.LogLineMaxBytes)
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.get(workloadID)
	s.ring.Add(l)
	if !s.bucket.Allow(m.now()) {
		s.dropped++
		return
	}
	s.pending = append(s.pending, l)
	s.bytes += len(l.Line) + 64
}

// Tail returns buffered lines (ok=false when nothing is buffered for the workload).
func (m *Manager) Tail(workloadID string, n int, since int64) ([]protocol.LogLine, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.streams[workloadID]
	if s == nil || s.ring.Len() == 0 {
		return nil, false
	}
	return s.ring.Tail(n, since), true
}

// Forget drops all state for a removed workload.
func (m *Manager) Forget(workloadID string) {
	m.mu.Lock()
	delete(m.streams, workloadID)
	m.mu.Unlock()
}

// Flush emits pending lines as frames (≤ 5000 lines and ≈1 MiB each).
func (m *Manager) Flush() {
	type out struct {
		id      string
		lines   []protocol.LogLine
		dropped int64
	}
	var batches []out
	m.mu.Lock()
	for id, s := range m.streams {
		if len(s.pending) == 0 && s.dropped == 0 {
			continue
		}
		batches = append(batches, out{id, s.pending, s.dropped})
		s.pending, s.bytes, s.dropped = nil, 0, 0
	}
	m.mu.Unlock()
	for _, b := range batches {
		lines := b.lines
		first := true
		for first || len(lines) > 0 {
			end, size := 0, 0
			for end < len(lines) && end < maxFrameLines && size < maxFrameBytes {
				size += len(lines[end].Line) + 64
				end++
			}
			f := protocol.LogsFrame{T: protocol.FrameLogs, WorkloadID: b.id, Lines: lines[:end]}
			if f.Lines == nil {
				f.Lines = []protocol.LogLine{}
			}
			if first && b.dropped > 0 {
				d := b.dropped
				f.Dropped = &d
			}
			m.emit(f)
			lines = lines[end:]
			first = false
		}
	}
}

// Run flushes every FlushInterval until ctx is done.
func (m *Manager) Run(ctx context.Context) {
	t := time.NewTicker(FlushInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			m.Flush()
			return
		case <-t.C:
			m.Flush()
		}
	}
}

// AddDropped counts lines lost outside the manager (e.g. logs frames evicted from the outbox).
func (m *Manager) AddDropped(workloadID string, n int) {
	if n <= 0 {
		return
	}
	m.mu.Lock()
	if s := m.streams[workloadID]; s != nil {
		s.dropped += int64(n)
	}
	m.mu.Unlock()
}
