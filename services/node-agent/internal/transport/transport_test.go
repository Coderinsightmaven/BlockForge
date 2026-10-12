package transport

import (
	"context"
	"testing"
	"time"
)

func TestBackoffFullJitter(t *testing.T) {
	b := NewBackoff(time.Second, 60*time.Second)
	var maxSeen []time.Duration
	b.rand = func(n int64) int64 { return n - 1 } // upper bound
	for i := 0; i < 10; i++ {
		maxSeen = append(maxSeen, b.Next())
	}
	want := []time.Duration{1, 2, 4, 8, 16, 32, 60, 60, 60, 60}
	for i, w := range want {
		if maxSeen[i] != w*time.Second {
			t.Fatalf("attempt %d: %v want %v", i, maxSeen[i], w*time.Second)
		}
	}
	b.Reset()
	if b.Ceiling() != time.Second {
		t.Fatal("reset")
	}
	// Real randomness stays within [0, ceiling].
	b2 := NewBackoff(time.Second, 60*time.Second)
	for i := 0; i < 1000; i++ {
		c := b2.Ceiling()
		d := b2.Next()
		if d < 0 || d > c {
			t.Fatalf("delay %v outside [0,%v]", d, c)
		}
		if i%7 == 0 {
			b2.Reset()
		}
	}
}

func TestOutboxPriorityAndDrops(t *testing.T) {
	o := NewOutbox(3, 2, 2)
	var droppedLines int
	o.OnLogsDropped = func(id string, n int) { droppedLines += n }
	o.Push(Item{Class: Metrics, Kind: "metrics", Data: []byte("m1")})
	o.Push(Item{Class: Metrics, Kind: "metrics", Data: []byte("m2")})
	o.Push(Item{Class: Metrics, Kind: "metrics", Data: []byte("m3")}) // evicts m1
	o.Push(Item{Class: Logs, Kind: "logs", Data: []byte("l1"), WorkloadID: "w", Lines: 7})
	o.Push(Item{Class: Logs, Kind: "logs", Data: []byte("l2"), Lines: 1})
	o.Push(Item{Class: Logs, Kind: "logs", Data: []byte("l3"), Lines: 1}) // evicts l1
	o.Push(Item{Class: High, Kind: "result", Data: []byte("r1")})
	o.Push(Item{Class: High, Kind: "progress", Data: []byte("p1")})
	o.Push(Item{Class: High, Kind: "result", Data: []byte("r2")})
	o.Push(Item{Class: High, Kind: "result", Data: []byte("r3")}) // evicts p1, never a result first
	if droppedLines != 7 {
		t.Fatalf("dropped lines %d", droppedLines)
	}
	ctx := context.Background()
	var order []string
	for i := 0; i < 7; i++ {
		it, _ := o.Next(ctx)
		order = append(order, string(it.Data))
	}
	want := "r1 r2 r3 l2 l3 m2 m3"
	got := ""
	for i, s := range order {
		if i > 0 {
			got += " "
		}
		got += s
	}
	if got != want {
		t.Fatalf("order %q want %q", got, want)
	}
	d := o.Dropped()
	if d[High] != 1 || d[Logs] != 1 || d[Metrics] != 1 {
		t.Fatalf("drops %v", d)
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
	defer cancel()
	if _, err := o.Next(cctx); err == nil {
		t.Fatal("empty outbox returned an item")
	}
	o.PushFront(Item{Class: High, Kind: "result", Data: []byte("again")})
	if it, _ := o.Next(ctx); string(it.Data) != "again" {
		t.Fatal("pushfront")
	}
}
