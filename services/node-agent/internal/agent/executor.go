// Package agent wires the node agent together: command verification and execution, transport,
// telemetry loops and the command handlers.
package agent

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"

	"github.com/blockforge/node-agent/internal/journal"
	"github.com/blockforge/node-agent/internal/protocol"
	"github.com/blockforge/node-agent/internal/transport"
)

// Command is a verified, validated command handed to a handler.
type Command struct {
	ID       string
	Type     string
	Body     *protocol.CommandBody
	Payload  any
	Progress func(stage, message string, percent *float64)
	// AfterResult runs once the result frame has been written (credential rotation).
	AfterResult func()
}

// Handler executes one command type.
type Handler func(ctx context.Context, c *Command) (any, error)

type entry struct {
	done      bool
	frame     []byte
	keepUntil time.Time
}

// Executor implements the agent-side command pipeline (agent-protocol.md §4): signature with the
// pinned control-plane key → nodeId → expiry (+30 s grace) → lifetime ≤ 15 min → seen-set
// (in-memory result cache + durable journal) → type → payload validation → execution.
type Executor struct {
	NodeID   string
	CPKey    ed25519.PublicKey
	Journal  *journal.Journal
	Send     func(transport.Item)
	Handlers map[string]Handler
	Approved func() bool
	Log      *slog.Logger
	Now      func() time.Time
	// Timeout returns the execution deadline for a command.
	Timeout func(c *Command) time.Duration

	sem      chan struct{}
	maxQueue int64
	queued   atomic.Int64

	mu      sync.Mutex
	entries map[string]*entry
	wlocks  sync.Map // workloadId → chan struct{}
	wg      sync.WaitGroup
	ctx     context.Context
}

// NewExecutor builds an executor with bounded concurrency.
func NewExecutor(ctx context.Context, concurrency int) *Executor {
	if concurrency <= 0 {
		concurrency = 8
	}
	return &Executor{
		sem: make(chan struct{}, concurrency), maxQueue: 64, entries: map[string]*entry{},
		Now: time.Now, Log: slog.Default(), ctx: ctx, Approved: func() bool { return true },
	}
}

func (e *Executor) sendResult(id string, data any, perr *protocol.Error, after func()) []byte {
	rf := protocol.ResultFrame{T: protocol.FrameResult, ID: id, TS: e.Now().UnixMilli()}
	if perr == nil {
		b, err := json.Marshal(data)
		if err != nil {
			perr = protocol.Errorf(protocol.CodeInternal, "encode result: %v", err)
		} else if len(b) > protocol.MaxFrameBytes-4096 {
			perr = protocol.Errorf(protocol.CodeQuotaExceeded, "result too large (%d bytes)", len(b))
		} else {
			rf.OK, rf.Data = true, b
		}
	}
	if perr != nil {
		rf.OK, rf.Data, rf.Error = false, nil, perr.ToAgentError()
	}
	frame, _ := json.Marshal(rf)
	e.Send(transport.Item{Class: transport.High, Kind: protocol.FrameResult, Data: frame, After: after})
	return frame
}

// Handle processes a cmd frame. It performs the envelope and replay checks synchronously and runs
// the command asynchronously; it never blocks the transport reader for long.
func (e *Executor) Handle(frame protocol.CommandFrame) {
	now := e.Now()
	body, reason := protocol.VerifyCommand(frame, e.CPKey, e.NodeID, now)
	if reason != "" {
		id := ""
		if body != nil {
			id = body.ID
		} else {
			id = protocol.BestEffortID(frame.Body)
		}
		e.Log.Warn("command rejected", "reason", reason, "id", id)
		if id != "" {
			// Not recorded in the seen-set: an unauthenticated id must not poison it.
			e.sendResult(id, nil, protocol.Errorf(protocol.CodeCommandRejected, "command rejected: %s", reason), nil)
		}
		return
	}
	e.mu.Lock()
	if en := e.entries[body.ID]; en != nil {
		e.mu.Unlock()
		if en.done {
			e.Log.Info("duplicate command; re-sending cached result", "id", body.ID)
			e.Send(transport.Item{Class: transport.High, Kind: protocol.FrameResult, Data: en.frame})
		} else {
			e.Log.Info("duplicate command ignored while running", "id", body.ID)
		}
		return
	}
	if e.Journal != nil && e.Journal.Contains(body.ID) {
		e.mu.Unlock()
		e.Log.Warn("replayed command id from before an agent restart rejected", "id", body.ID)
		e.sendResult(body.ID, nil, protocol.Errorf(protocol.CodeCommandRejected, "duplicate command id (seen before an agent restart)"), nil)
		return
	}
	if e.Journal != nil {
		if err := e.Journal.Append(body.ID, body.ExpiresAt); err != nil {
			e.mu.Unlock()
			e.Log.Error("command journal append failed", "err", err)
			e.sendResult(body.ID, nil, protocol.RetryableErrorf(protocol.CodeInternal, "cannot persist replay journal"), nil)
			return
		}
	}
	e.entries[body.ID] = &entry{}
	e.mu.Unlock()
	e.wg.Add(1)
	go e.run(body)
}

func (e *Executor) finish(c *Command, data any, err error) {
	var perr *protocol.Error
	if err != nil {
		perr = e.toProtocolError(c, err)
	}
	var after func()
	if perr == nil {
		after = c.AfterResult
	}
	frame := e.sendResult(c.ID, data, perr, after)
	keep := e.Now().Add(protocol.ResultCacheMs * time.Millisecond)
	if exp := time.UnixMilli(c.Body.ExpiresAt + protocol.CommandExpiryGraceMs + 1000); exp.After(keep) {
		keep = exp
	}
	e.mu.Lock()
	e.entries[c.ID] = &entry{done: true, frame: frame, keepUntil: keep}
	e.mu.Unlock()
}

func (e *Executor) toProtocolError(c *Command, err error) *protocol.Error {
	if pe, ok := protocol.AsError(err); ok {
		return pe
	}
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return protocol.RetryableErrorf(protocol.CodeTimeout, "%s timed out", c.Type)
	case errors.Is(err, context.Canceled):
		return protocol.RetryableErrorf(protocol.CodeInternal, "agent is shutting down")
	}
	e.Log.Error("command failed", "id", c.ID, "type", c.Type, "err", err)
	return protocol.Errorf(protocol.CodeInternal, "internal error")
}

func (e *Executor) lockWorkload(ctx context.Context, id string) (func(), error) {
	v, _ := e.wlocks.LoadOrStore(id, make(chan struct{}, 1))
	ch := v.(chan struct{})
	select {
	case ch <- struct{}{}:
		return func() { <-ch }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (e *Executor) run(body *protocol.CommandBody) {
	defer e.wg.Done()
	c := &Command{ID: body.ID, Type: body.Type, Body: body}
	defer func() {
		if r := recover(); r != nil {
			e.Log.Error("command handler panicked", "id", c.ID, "type", c.Type, "panic", fmt.Sprint(r), "stack", string(debug.Stack()))
			e.finish(c, nil, protocol.Errorf(protocol.CodeInternal, "internal error"))
		}
	}()
	if !e.Approved() && body.Type != protocol.CmdNodeFacts {
		e.finish(c, nil, protocol.Errorf(protocol.CodeCommandRejected, "node is pending approval; only node.facts is allowed"))
		return
	}
	payload, known, perr := protocol.ParsePayload(body.Type, body.Payload)
	if !known {
		e.finish(c, nil, protocol.Errorf(protocol.CodeUnsupportedCommand, "unsupported command type %q", truncate(body.Type, 64)))
		return
	}
	if perr != nil {
		e.finish(c, nil, perr)
		return
	}
	h := e.Handlers[body.Type]
	if h == nil {
		e.finish(c, nil, protocol.Errorf(protocol.CodeUnsupportedCommand, "command %q is not supported by this agent", body.Type))
		return
	}
	c.Payload = payload
	c.Progress = e.progressFor(c.ID)
	timeout := 5 * time.Minute
	if e.Timeout != nil {
		timeout = e.Timeout(c)
	}
	ctx, cancel := context.WithTimeout(e.ctx, timeout)
	defer cancel()

	if e.queued.Add(1) > e.maxQueue {
		e.queued.Add(-1)
		e.finish(c, nil, protocol.RetryableErrorf(protocol.CodeBusy, "agent command queue is full"))
		return
	}
	if wid := protocol.WorkloadIDOf(payload); wid != "" && protocol.Commands[body.Type].Mutating {
		unlock, err := e.lockWorkload(ctx, wid)
		if err != nil {
			e.queued.Add(-1)
			e.finish(c, nil, err)
			return
		}
		defer unlock()
	}
	select {
	case e.sem <- struct{}{}:
	case <-ctx.Done():
		e.queued.Add(-1)
		e.finish(c, nil, ctx.Err())
		return
	}
	e.queued.Add(-1)
	defer func() { <-e.sem }()
	data, err := h(ctx, c)
	if err == nil && ctx.Err() != nil {
		err = ctx.Err()
	}
	e.finish(c, data, err)
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// progressFor emits progress frames, at most two per second per command.
func (e *Executor) progressFor(id string) func(stage, message string, percent *float64) {
	var mu sync.Mutex
	var last time.Time
	return func(stage, message string, percent *float64) {
		mu.Lock()
		now := e.Now()
		if now.Sub(last) < 500*time.Millisecond && (percent == nil || *percent < 100) {
			mu.Unlock()
			return
		}
		last = now
		mu.Unlock()
		pf := protocol.ProgressFrame{T: protocol.FrameProgress, ID: id, TS: now.UnixMilli(), Stage: truncate(stage, 64), Message: truncate(message, 1024)}
		if percent != nil {
			p := *percent
			if p < 0 {
				p = 0
			}
			if p > 100 {
				p = 100
			}
			pf.Percent = &p
		}
		b, _ := json.Marshal(pf)
		e.Send(transport.Item{Class: transport.High, Kind: protocol.FrameProgress, Data: b})
	}
}

// Janitor evicts expired cached results and prunes the journal.
func (e *Executor) Janitor(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			e.Sweep()
		}
	}
}

// Sweep runs one eviction pass.
func (e *Executor) Sweep() {
	now := e.Now()
	e.mu.Lock()
	for id, en := range e.entries {
		if en.done && now.After(en.keepUntil) {
			delete(e.entries, id)
		}
	}
	e.mu.Unlock()
	if e.Journal != nil {
		if err := e.Journal.Prune(now); err != nil {
			e.Log.Warn("journal prune", "err", err)
		}
	}
}

// Wait blocks until running commands finished or the timeout elapsed.
func (e *Executor) Wait(timeout time.Duration) {
	done := make(chan struct{})
	go func() { e.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(timeout):
	}
}
