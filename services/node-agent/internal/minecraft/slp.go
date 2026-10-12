// Package minecraft implements the Java Edition Server List Ping (handshake → status → ping/pong)
// with VarInt framing, and flattens chat-component MOTDs to plain text.
package minecraft

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/blockforge/node-agent/internal/protocol"
)

// Limits for untrusted server responses.
const (
	maxPacket       = 2 << 20 // status JSON incl. favicon
	maxSamplePlayer = 50
	maxNameLen      = 64
	maxMotdLen      = 1024
	maxVersionLen   = 256
)

// WriteVarInt appends a protocol VarInt.
func WriteVarInt(b []byte, v int32) []byte {
	u := uint32(v)
	for {
		if u&^0x7f == 0 {
			return append(b, byte(u))
		}
		b = append(b, byte(u&0x7f|0x80))
		u >>= 7
	}
}

// ReadVarInt reads a protocol VarInt (max 5 bytes).
func ReadVarInt(r io.ByteReader) (int32, error) {
	var v uint32
	for i := 0; i < 5; i++ {
		c, err := r.ReadByte()
		if err != nil {
			return 0, err
		}
		v |= uint32(c&0x7f) << (7 * i)
		if c&0x80 == 0 {
			return int32(v), nil
		}
	}
	return 0, errors.New("varint too long")
}

func packet(id int32, body []byte) []byte {
	inner := WriteVarInt(nil, id)
	inner = append(inner, body...)
	out := WriteVarInt(nil, int32(len(inner)))
	return append(out, inner...)
}

func readPacket(r *bufio.Reader) (int32, []byte, error) {
	n, err := ReadVarInt(r)
	if err != nil {
		return 0, nil, err
	}
	if n <= 0 || n > maxPacket {
		return 0, nil, fmt.Errorf("invalid packet length %d", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0, nil, err
	}
	br := bytes.NewReader(buf)
	id, err := ReadVarInt(br)
	if err != nil {
		return 0, nil, err
	}
	rest, _ := io.ReadAll(br)
	return id, rest, nil
}

// Ping performs a full status ping against host:port. latencyMs is the ping/pong round trip
// (falling back to the status round trip if the server closes before pong).
func Ping(ctx context.Context, host string, port int, timeout time.Duration) (*protocol.SlpStatus, error) {
	d := net.Dialer{Timeout: timeout}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	conn, err := d.DialContext(cctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	deadline, _ := cctx.Deadline()
	_ = conn.SetDeadline(deadline)

	// Handshake: protocol version -1 (version probing convention), address, port, next state 1.
	hs := WriteVarInt(nil, -1)
	addr := host
	if len(addr) > 255 {
		addr = addr[:255]
	}
	hs = WriteVarInt(hs, int32(len(addr)))
	hs = append(hs, addr...)
	hs = binary.BigEndian.AppendUint16(hs, uint16(port))
	hs = WriteVarInt(hs, 1)
	msg := append(packet(0x00, hs), packet(0x00, nil)...)
	start := time.Now()
	if _, err := conn.Write(msg); err != nil {
		return nil, err
	}
	r := bufio.NewReader(conn)
	id, body, err := readPacket(r)
	if err != nil {
		return nil, fmt.Errorf("read status: %w", err)
	}
	statusRTT := time.Since(start)
	if id != 0x00 {
		return nil, fmt.Errorf("unexpected packet id 0x%02x", id)
	}
	br := bytes.NewReader(body)
	sl, err := ReadVarInt(br)
	if err != nil || sl < 0 || int(sl) > br.Len() {
		return nil, errors.New("malformed status string")
	}
	js := make([]byte, sl)
	_, _ = io.ReadFull(br, js)
	st, err := ParseStatus(js)
	if err != nil {
		return nil, err
	}
	st.LatencyMs = float64(statusRTT.Microseconds()) / 1000

	payload := time.Now().UnixNano()
	pingStart := time.Now()
	if _, err := conn.Write(packet(0x01, binary.BigEndian.AppendUint64(nil, uint64(payload)))); err == nil {
		if pid, pb, err := readPacket(r); err == nil && pid == 0x01 && len(pb) == 8 &&
			int64(binary.BigEndian.Uint64(pb)) == payload {
			st.LatencyMs = float64(time.Since(pingStart).Microseconds()) / 1000
		}
	}
	return st, nil
}

type statusJSON struct {
	Version *struct {
		Name     any `json:"name"`
		Protocol any `json:"protocol"`
	} `json:"version"`
	Players *struct {
		Max    any `json:"max"`
		Online any `json:"online"`
		Sample []struct {
			Name any `json:"name"`
			ID   any `json:"id"`
		} `json:"sample"`
	} `json:"players"`
	Description any `json:"description"`
}

func toInt(v any) (int, bool) {
	f, ok := v.(float64)
	if !ok || f != float64(int64(f)) || f < -1<<31 || f > 1<<31 {
		return 0, false
	}
	return int(f), true
}

func clip(s string, n int) string {
	s = strings.ToValidUTF8(s, "�")
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// ParseStatus parses the status JSON. Strings are untrusted and length-capped.
func ParseStatus(b []byte) (*protocol.SlpStatus, error) {
	var sj statusJSON
	if err := json.Unmarshal(b, &sj); err != nil {
		return nil, fmt.Errorf("status JSON: %w", err)
	}
	if sj.Players == nil {
		return nil, errors.New("status response has no players object")
	}
	online, ok1 := toInt(sj.Players.Online)
	max, ok2 := toInt(sj.Players.Max)
	if !ok1 || !ok2 || online < 0 || max < 0 {
		return nil, errors.New("status response has invalid player counts")
	}
	st := &protocol.SlpStatus{PlayersOnline: online, PlayersMax: max, PlayerSample: []protocol.SlpPlayer{}}
	if sj.Version != nil {
		if name, ok := sj.Version.Name.(string); ok {
			st.VersionName = clip(name, maxVersionLen)
		}
		if p, ok := toInt(sj.Version.Protocol); ok {
			st.Protocol = &p
		}
	}
	for _, s := range sj.Players.Sample {
		if len(st.PlayerSample) >= maxSamplePlayer {
			break
		}
		name, _ := s.Name.(string)
		id, _ := s.ID.(string)
		st.PlayerSample = append(st.PlayerSample, protocol.SlpPlayer{Name: clip(name, maxNameLen), ID: clip(id, 64)})
	}
	if motd := strings.TrimSpace(StripFormatting(FlattenChat(sj.Description))); motd != "" {
		st.Motd = clip(motd, maxMotdLen)
	}
	return st, nil
}

// FlattenChat converts a chat component (string, object with text/extra/translate, or array)
// into plain text.
func FlattenChat(v any) string {
	var sb strings.Builder
	flatten(&sb, v, 0)
	return sb.String()
}

func flatten(sb *strings.Builder, v any, depth int) {
	if depth > 32 || sb.Len() > 16*1024 {
		return
	}
	switch c := v.(type) {
	case string:
		sb.WriteString(c)
	case []any:
		for _, e := range c {
			flatten(sb, e, depth+1)
		}
	case map[string]any:
		if t, ok := c["text"].(string); ok {
			sb.WriteString(t)
		} else if t, ok := c["translate"].(string); ok {
			if fb, ok := c["fallback"].(string); ok {
				sb.WriteString(fb)
			} else {
				sb.WriteString(t)
			}
		}
		if extra, ok := c["extra"].([]any); ok {
			for _, e := range extra {
				flatten(sb, e, depth+1)
			}
		}
	}
}

// StripFormatting removes legacy § formatting codes.
func StripFormatting(s string) string {
	if !strings.ContainsRune(s, '§') {
		return s
	}
	var sb strings.Builder
	skip := false
	for _, r := range s {
		if skip {
			skip = false
			continue
		}
		if r == '§' {
			skip = true
			continue
		}
		sb.WriteRune(r)
	}
	return sb.String()
}

// ProbeTCP measures a TCP connect.
func ProbeTCP(ctx context.Context, host string, port int, timeout time.Duration) (time.Duration, error) {
	d := net.Dialer{Timeout: timeout}
	start := time.Now()
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return 0, err
	}
	elapsed := time.Since(start)
	conn.Close()
	return elapsed, nil
}
