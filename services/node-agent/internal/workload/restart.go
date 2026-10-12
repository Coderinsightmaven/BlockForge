package workload

import (
	"time"

	"github.com/blockforge/node-agent/internal/protocol"
)

// StableResetAfter resets the restart counter when a run lasted at least this long.
const StableResetAfter = 10 * time.Minute

// maxBackoff caps the exponential restart delay.
const maxBackoff = 10 * time.Minute

// RestartTracker is the agent-side restart policy state machine for one workload. It lets crash
// recovery work while the control plane is unreachable. Deliberate stops never restart.
type RestartTracker struct {
	Policy     protocol.RestartPolicy
	Retries    int
	LastStart  time.Time
	Deliberate bool
	GaveUp     bool
}

// Decision is the outcome of an exit.
type Decision struct {
	Restart bool
	Delay   time.Duration
	GaveUp  bool
	Reason  string
}

// OnStart records a (re)start. A manual start resets the retry budget.
func (t *RestartTracker) OnStart(now time.Time, manual bool) {
	t.LastStart = now
	t.Deliberate = false
	if manual {
		t.Retries = 0
		t.GaveUp = false
	}
}

// MarkDeliberate is called before an operator-initiated stop/kill/remove.
func (t *RestartTracker) MarkDeliberate() { t.Deliberate = true }

// OnExit decides whether to restart after the container exited with exitCode.
func (t *RestartTracker) OnExit(now time.Time, exitCode int) Decision {
	if t.Deliberate {
		return Decision{Reason: "deliberate stop"}
	}
	if !t.LastStart.IsZero() && now.Sub(t.LastStart) >= StableResetAfter {
		t.Retries = 0
		t.GaveUp = false
	}
	switch t.Policy.Mode {
	case "on-failure":
		if exitCode == 0 {
			return Decision{Reason: "clean exit"}
		}
	case "always":
	default:
		return Decision{Reason: "restart policy never"}
	}
	if t.Retries >= t.Policy.MaxRetries {
		t.GaveUp = true
		return Decision{GaveUp: true, Reason: "restart limit reached"}
	}
	t.Retries++
	delay := time.Duration(t.Policy.BackoffMs) * time.Millisecond
	for i := 1; i < t.Retries && delay < maxBackoff; i++ {
		delay *= 2
	}
	if delay > maxBackoff {
		delay = maxBackoff
	}
	return Decision{Restart: true, Delay: delay, Reason: "restart policy " + t.Policy.Mode}
}
