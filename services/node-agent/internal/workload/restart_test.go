package workload

import (
	"testing"
	"time"

	"github.com/blockforge/node-agent/internal/protocol"
)

func TestRestartPolicyStateMachine(t *testing.T) {
	t0 := time.Unix(1_760_000_000, 0)
	tr := &RestartTracker{Policy: protocol.RestartPolicy{Mode: "on-failure", MaxRetries: 3, BackoffMs: 10_000}}
	tr.OnStart(t0, true)
	var delays []time.Duration
	now := t0
	for i := 0; i < 3; i++ {
		now = now.Add(5 * time.Second)
		d := tr.OnExit(now, 1)
		if !d.Restart {
			t.Fatalf("crash %d not restarted: %+v", i, d)
		}
		delays = append(delays, d.Delay)
		tr.OnStart(now.Add(d.Delay), false)
	}
	if delays[0] != 10*time.Second || delays[1] != 20*time.Second || delays[2] != 40*time.Second {
		t.Fatalf("backoff %v", delays)
	}
	if d := tr.OnExit(now.Add(time.Minute), 1); d.Restart || !d.GaveUp {
		t.Fatalf("4th crash must give up: %+v", d)
	}
	// Manual start resets the budget.
	tr.OnStart(now.Add(2*time.Minute), true)
	if d := tr.OnExit(now.Add(3*time.Minute), 137); !d.Restart || d.Delay != 10*time.Second {
		t.Fatalf("after manual start: %+v", d)
	}
	// on-failure: clean exit does not restart.
	tr.OnStart(now.Add(4*time.Minute), false)
	if d := tr.OnExit(now.Add(5*time.Minute), 0); d.Restart {
		t.Fatal("on-failure restarted a clean exit")
	}
	// Deliberate stop/kill never restarts, even with "always" and a non-zero exit code.
	al := &RestartTracker{Policy: protocol.RestartPolicy{Mode: "always", MaxRetries: 5, BackoffMs: 1000}}
	al.OnStart(t0, true)
	al.MarkDeliberate()
	if d := al.OnExit(t0.Add(time.Second), 137); d.Restart {
		t.Fatal("deliberate kill restarted")
	}
	al.OnStart(t0.Add(time.Minute), true)
	if d := al.OnExit(t0.Add(2*time.Minute), 0); !d.Restart {
		t.Fatal("always must restart a clean exit")
	}
	// Counter resets after 10 minutes of stable running.
	st := &RestartTracker{Policy: protocol.RestartPolicy{Mode: "on-failure", MaxRetries: 1, BackoffMs: 1000}}
	st.OnStart(t0, true)
	if d := st.OnExit(t0.Add(time.Second), 1); !d.Restart {
		t.Fatal("first crash")
	}
	st.OnStart(t0.Add(2*time.Second), false)
	if d := st.OnExit(t0.Add(3*time.Second), 1); !d.GaveUp {
		t.Fatal("budget of 1 exhausted")
	}
	st.OnStart(t0.Add(time.Hour), false)
	if d := st.OnExit(t0.Add(time.Hour+11*time.Minute), 1); !d.Restart {
		t.Fatalf("stable run must reset the counter: %+v", d)
	}
	nv := &RestartTracker{Policy: protocol.RestartPolicy{Mode: "never"}}
	if d := nv.OnExit(t0, 1); d.Restart {
		t.Fatal("never restarted")
	}
	// Backoff is capped.
	big := &RestartTracker{Policy: protocol.RestartPolicy{Mode: "always", MaxRetries: 100, BackoffMs: 600_000}}
	for i := 0; i < 5; i++ {
		if d := big.OnExit(t0, 1); d.Delay > maxBackoff {
			t.Fatalf("delay %v exceeds cap", d.Delay)
		}
	}
}
