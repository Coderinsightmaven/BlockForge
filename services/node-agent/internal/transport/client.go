package transport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/blockforge/node-agent/internal/protocol"
)

// ErrAuthRejected is returned for a 401/403 at the WebSocket upgrade.
var ErrAuthRejected = errors.New("control plane rejected the agent credentials")

// Options configures the client.
type Options struct {
	URL        string
	HTTPClient *http.Client
	// Auth returns a fresh Authorization header; usingNext reports whether the staged next key signed it.
	Auth func() (header string, usingNext bool, err error)
	// OnAuthRejected is called after a 401/403 at upgrade.
	OnAuthRejected func(usingNext bool)
	// Hello builds the hello frame for a new session.
	Hello func(ctx context.Context) ([]byte, error)
	// OnWelcome runs when the control plane accepted the session.
	OnWelcome func(w protocol.WelcomeFrame, usingNext bool)
	// OnCommand receives every cmd frame (must not block).
	OnCommand func(protocol.CommandFrame)
	// OnDisconnect runs when a session ends.
	OnDisconnect func(err error)
	Outbox       *Outbox
	Logger       *slog.Logger

	BackoffBase, BackoffCap time.Duration
	// StableAfter resets the backoff once a session lasted this long after welcome.
	StableAfter    time.Duration
	WelcomeTimeout time.Duration
	PingInterval   time.Duration
}

// Client is the reconnecting WebSocket client.
type Client struct {
	o         Options
	reconnect chan struct{}
	connected atomic.Bool
	hbMs      atomic.Int64
	started   time.Time
}

// New validates options and returns a client.
func New(o Options) *Client {
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	if o.HTTPClient == nil {
		o.HTTPClient = http.DefaultClient
	}
	if o.StableAfter <= 0 {
		o.StableAfter = 30 * time.Second
	}
	if o.WelcomeTimeout <= 0 {
		o.WelcomeTimeout = 15 * time.Second
	}
	if o.PingInterval <= 0 {
		o.PingInterval = 30 * time.Second
	}
	c := &Client{o: o, reconnect: make(chan struct{}, 1), started: time.Now()}
	c.hbMs.Store(15000)
	return c
}

// Connected reports whether a welcomed session is active.
func (c *Client) Connected() bool { return c.connected.Load() }

// Reconnect asks the current session to close and reconnect (used after credential rotation).
func (c *Client) Reconnect() {
	select {
	case c.reconnect <- struct{}{}:
	default:
	}
}

// Run keeps a session alive until ctx is cancelled.
func (c *Client) Run(ctx context.Context) error {
	bo := NewBackoff(c.o.BackoffBase, c.o.BackoffCap)
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		stable, err := c.session(ctx)
		c.connected.Store(false)
		if c.o.OnDisconnect != nil {
			c.o.OnDisconnect(err)
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if stable {
			bo.Reset()
		}
		delay := bo.Next()
		c.o.Logger.Warn("control-plane session ended; reconnecting", "err", err, "in", delay.Round(time.Millisecond))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
}

func (c *Client) uptimeMs() int64 { return time.Since(c.started).Milliseconds() }

// session runs one connection. stable reports whether it lasted StableAfter past welcome.
func (c *Client) session(ctx context.Context) (stable bool, err error) {
	// A reconnect request that arrived between sessions is satisfied by this new session.
	select {
	case <-c.reconnect:
	default:
	}
	header, usingNext, err := c.o.Auth()
	if err != nil {
		return false, fmt.Errorf("auth token: %w", err)
	}
	dctx, dcancel := context.WithTimeout(ctx, 20*time.Second)
	conn, resp, err := websocket.Dial(dctx, c.o.URL, &websocket.DialOptions{
		HTTPClient: c.o.HTTPClient,
		HTTPHeader: http.Header{"Authorization": []string{header}, "User-Agent": []string{"BlockForge-Agent"}},
	})
	dcancel()
	if err != nil {
		if resp != nil && (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) {
			if c.o.OnAuthRejected != nil {
				c.o.OnAuthRejected(usingNext)
			}
			return false, fmt.Errorf("%w (HTTP %d)", ErrAuthRejected, resp.StatusCode)
		}
		return false, fmt.Errorf("dial: %w", err)
	}
	defer conn.CloseNow()
	conn.SetReadLimit(protocol.MaxFrameBytes)

	sctx, cancel := context.WithCancel(ctx)
	defer cancel()

	hello, err := c.o.Hello(sctx)
	if err != nil {
		return false, fmt.Errorf("build hello: %w", err)
	}
	wctx, wcancel := context.WithTimeout(sctx, 30*time.Second)
	err = conn.Write(wctx, websocket.MessageText, hello)
	wcancel()
	if err != nil {
		return false, fmt.Errorf("send hello: %w", err)
	}

	welcomeCh := make(chan protocol.WelcomeFrame, 1)
	readErr := make(chan error, 1)
	go func() {
		for {
			typ, data, err := conn.Read(sctx)
			if err != nil {
				readErr <- err
				return
			}
			if typ != websocket.MessageText {
				continue
			}
			var head struct {
				T string `json:"t"`
			}
			if json.Unmarshal(data, &head) != nil {
				c.o.Logger.Warn("ignoring malformed control-plane frame")
				continue
			}
			switch head.T {
			case protocol.FrameWelcome:
				var w protocol.WelcomeFrame
				if json.Unmarshal(data, &w) == nil {
					select {
					case welcomeCh <- w:
					default:
					}
				}
			case protocol.FrameCmd:
				var f protocol.CommandFrame
				if json.Unmarshal(data, &f) == nil && c.o.OnCommand != nil {
					c.o.OnCommand(f)
				}
			default:
				// Unknown frame types are ignored (forward compatibility).
			}
		}
	}()

	var welcome protocol.WelcomeFrame
	select {
	case welcome = <-welcomeCh:
	case err := <-readErr:
		return false, fmt.Errorf("before welcome: %w", err)
	case <-time.After(c.o.WelcomeTimeout):
		return false, errors.New("no welcome from control plane")
	case <-ctx.Done():
		conn.Close(websocket.StatusGoingAway, "agent shutting down")
		return false, ctx.Err()
	}
	welcomedAt := time.Now()
	if welcome.HeartbeatIntervalMs > 0 {
		c.hbMs.Store(welcome.HeartbeatIntervalMs)
	}
	c.connected.Store(true)
	if c.o.OnWelcome != nil {
		c.o.OnWelcome(welcome, usingNext)
	}
	c.o.Logger.Info("connected to control plane", "nodeId", welcome.NodeID, "approved", welcome.Approved)

	writeErr := make(chan error, 1)
	go func() {
		for {
			it, err := c.o.Outbox.Next(sctx)
			if err != nil {
				return
			}
			if len(it.Data) > protocol.MaxFrameBytes {
				c.o.Logger.Error("dropping oversized frame", "kind", it.Kind, "bytes", len(it.Data))
				continue
			}
			wctx, wcancel := context.WithTimeout(sctx, 30*time.Second)
			err = conn.Write(wctx, websocket.MessageText, it.Data)
			wcancel()
			if err != nil {
				c.o.Outbox.PushFront(it)
				writeErr <- err
				return
			}
			if it.After != nil {
				it.After()
			}
		}
	}()

	hb := time.NewTicker(time.Duration(c.hbMs.Load()) * time.Millisecond)
	defer hb.Stop()
	ping := time.NewTicker(c.o.PingInterval)
	defer ping.Stop()
	isStable := func() bool { return time.Since(welcomedAt) >= c.o.StableAfter }
	for {
		select {
		case <-ctx.Done():
			// Give queued results a moment to drain, then close cleanly.
			deadline := time.Now().Add(2 * time.Second)
			for time.Now().Before(deadline) && c.o.Outbox.Len()[High] > 0 {
				time.Sleep(50 * time.Millisecond)
			}
			conn.Close(websocket.StatusNormalClosure, "agent shutting down")
			return isStable(), ctx.Err()
		case err := <-readErr:
			return isStable(), fmt.Errorf("read: %w", err)
		case err := <-writeErr:
			return isStable(), fmt.Errorf("write: %w", err)
		case <-c.reconnect:
			deadline := time.Now().Add(2 * time.Second)
			for time.Now().Before(deadline) && c.o.Outbox.Len()[High] > 0 {
				time.Sleep(20 * time.Millisecond)
			}
			conn.Close(websocket.StatusNormalClosure, "reconnecting")
			return true, errors.New("reconnect requested")
		case <-hb.C:
			b, _ := json.Marshal(protocol.HeartbeatFrame{T: protocol.FrameHeartbeat, TS: time.Now().UnixMilli(), UptimeMs: c.uptimeMs()})
			c.o.Outbox.Push(Item{Class: High, Kind: protocol.FrameHeartbeat, Data: b})
		case <-ping.C:
			go func() {
				pctx, pcancel := context.WithTimeout(sctx, 15*time.Second)
				defer pcancel()
				if err := conn.Ping(pctx); err != nil && sctx.Err() == nil {
					c.o.Logger.Warn("websocket ping failed", "err", err)
					cancel()
				}
			}()
		}
	}
}
