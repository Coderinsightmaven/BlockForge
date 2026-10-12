// Package transport maintains the agent → control-plane WebSocket: fresh BFAgent token per
// connection, hello → welcome handshake, heartbeats, reconnect with exponential backoff and full
// jitter, and a bounded priority outbox (result/progress/event > logs > metrics).
package transport

import (
	"context"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"
)

// Class is an outbox priority class.
type Class int

const (
	// High carries hello-independent control traffic: results, progress, events, heartbeats.
	High Class = iota
	// Logs carries logs frames (drop-oldest under pressure).
	Logs
	// Metrics carries metrics frames (drop-oldest under pressure).
	Metrics
)

// Item is one serialised frame.
type Item struct {
	Class Class
	// Kind is the frame type ("result", "progress", …); results are the last thing ever dropped.
	Kind string
	Data []byte
	// After runs once the frame has been written to the socket.
	After func()
	// WorkloadID/Lines let a dropped logs frame be re-counted as dropped lines.
	WorkloadID string
	Lines      int
}

// Outbox is a bounded, prioritised frame queue that survives reconnects.
type Outbox struct {
	mu     sync.Mutex
	queues [3][]Item
	caps   [3]int
	notify chan struct{}

	dropped [3]atomic.Int64
	// OnLogsDropped is told about logs frames evicted under pressure.
	OnLogsDropped func(workloadID string, lines int)
}

// NewOutbox creates an outbox with the given per-class capacities (frames).
func NewOutbox(highCap, logsCap, metricsCap int) *Outbox {
	return &Outbox{caps: [3]int{highCap, logsCap, metricsCap}, notify: make(chan struct{}, 1)}
}

// Push enqueues an item, evicting under pressure (oldest metrics/logs; for High the oldest
// non-result frame first).
func (o *Outbox) Push(it Item) {
	var evicted *Item
	o.mu.Lock()
	q := o.queues[it.Class]
	if len(q) >= o.caps[it.Class] {
		idx := 0
		if it.Class == High {
			for i, e := range q {
				if e.Kind != "result" {
					idx = i
					break
				}
			}
		}
		e := q[idx]
		evicted = &e
		q = append(q[:idx], q[idx+1:]...)
		o.dropped[it.Class].Add(1)
	}
	o.queues[it.Class] = append(q, it)
	o.mu.Unlock()
	if evicted != nil && evicted.Class == Logs && o.OnLogsDropped != nil && evicted.Lines > 0 {
		o.OnLogsDropped(evicted.WorkloadID, evicted.Lines)
	}
	select {
	case o.notify <- struct{}{}:
	default:
	}
}

// PushFront re-queues an item that failed to send.
func (o *Outbox) PushFront(it Item) {
	o.mu.Lock()
	o.queues[it.Class] = append([]Item{it}, o.queues[it.Class]...)
	o.mu.Unlock()
	select {
	case o.notify <- struct{}{}:
	default:
	}
}

func (o *Outbox) pop() (Item, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	for c := range o.queues {
		if len(o.queues[c]) > 0 {
			it := o.queues[c][0]
			o.queues[c] = o.queues[c][1:]
			return it, true
		}
	}
	return Item{}, false
}

// Next blocks until an item is available (highest priority first) or ctx is done.
func (o *Outbox) Next(ctx context.Context) (Item, error) {
	for {
		if it, ok := o.pop(); ok {
			return it, nil
		}
		select {
		case <-ctx.Done():
			return Item{}, ctx.Err()
		case <-o.notify:
		}
	}
}

// Len returns queued items per class.
func (o *Outbox) Len() [3]int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return [3]int{len(o.queues[0]), len(o.queues[1]), len(o.queues[2])}
}

// Dropped returns eviction counters per class.
func (o *Outbox) Dropped() [3]int64 {
	return [3]int64{o.dropped[0].Load(), o.dropped[1].Load(), o.dropped[2].Load()}
}

// DropClass discards all queued items of a class (e.g. stale metrics after a long outage).
func (o *Outbox) DropClass(c Class) {
	o.mu.Lock()
	n := len(o.queues[c])
	o.queues[c] = nil
	o.mu.Unlock()
	o.dropped[c].Add(int64(n))
}

// Backoff is exponential backoff with full jitter: sleep = U(0, min(cap, base·2^attempt)).
type Backoff struct {
	Base, Cap time.Duration
	attempt   int
	rand      func(n int64) int64
}

// NewBackoff builds a backoff with the protocol defaults if zero values are passed.
func NewBackoff(base, cap time.Duration) *Backoff {
	if base <= 0 {
		base = time.Second
	}
	if cap <= 0 {
		cap = 60 * time.Second
	}
	return &Backoff{Base: base, Cap: cap, rand: rand.Int64N}
}

// Ceiling returns the current upper bound without advancing.
func (b *Backoff) Ceiling() time.Duration {
	c := b.Base
	for i := 0; i < b.attempt && c < b.Cap; i++ {
		c *= 2
	}
	if c > b.Cap {
		c = b.Cap
	}
	return c
}

// Next returns the next delay and advances the attempt counter.
func (b *Backoff) Next() time.Duration {
	c := b.Ceiling()
	b.attempt++
	return time.Duration(b.rand(int64(c) + 1))
}

// Reset starts over after a stable connection.
func (b *Backoff) Reset() { b.attempt = 0 }
