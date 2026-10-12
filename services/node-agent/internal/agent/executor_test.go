package agent

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/blockforge/node-agent/internal/auth"
	"github.com/blockforge/node-agent/internal/journal"
	"github.com/blockforge/node-agent/internal/protocol"
	"github.com/blockforge/node-agent/internal/transport"
)

// A journal that cannot persist ids must fail closed: retryable INTERNAL, handler never runs.
func TestExecutorFailsClosedWhenJournalUnavailable(t *testing.T) {
	cp, _ := auth.KeyFromSeedHex(cpSeed)
	j, err := journal.Open(filepath.Join(t.TempDir(), "commands.journal"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	j.Close() // every Append now fails
	var mu sync.Mutex
	var frames []protocol.ResultFrame
	var ran atomic.Int32
	e := NewExecutor(context.Background(), 2)
	e.NodeID, e.CPKey, e.Journal = testNodeID, cp.Public().(ed25519.PublicKey), j
	e.Log = quietLogger()
	e.Send = func(it transport.Item) {
		var rf protocol.ResultFrame
		json.Unmarshal(it.Data, &rf)
		mu.Lock()
		frames = append(frames, rf)
		mu.Unlock()
	}
	e.Handlers = map[string]Handler{protocol.CmdNodeFacts: func(context.Context, *Command) (any, error) {
		ran.Add(1)
		return map[string]any{}, nil
	}}
	f := (&fakeCP{cp: cp}).signCmd("00000000-0000-4000-8000-0000000000e1", protocol.CmdNodeFacts, map[string]any{}, time.Now(), time.Minute)
	e.Handle(f)
	e.Wait(5 * time.Second)
	mu.Lock()
	if len(frames) != 1 || frames[0].OK || frames[0].Error.Code != protocol.CodeInternal || !frames[0].Error.Retryable {
		t.Fatalf("frames %+v", frames)
	}
	mu.Unlock()
	if ran.Load() != 0 {
		t.Fatal("command executed although its id could not be journaled")
	}
	// Not cached: once the journal works again the control plane can retry the same id.
	e.Handle(f)
	e.Wait(5 * time.Second)
	mu.Lock()
	defer mu.Unlock()
	if len(frames) != 2 || ran.Load() != 0 {
		t.Fatalf("retry: %d frames, ran %d", len(frames), ran.Load())
	}
}
