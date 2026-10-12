package minecraft

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"net"
	"strings"
	"testing"
	"time"
)

func TestVarIntRoundTrip(t *testing.T) {
	for _, v := range []int32{0, 1, 127, 128, 255, 25565, 2097151, 2147483647, -1, -2147483648} {
		b := WriteVarInt(nil, v)
		got, err := ReadVarInt(bytes.NewReader(b))
		if err != nil || got != v {
			t.Fatalf("%d: got %d err %v (% x)", v, got, err, b)
		}
	}
	if b := WriteVarInt(nil, -1); len(b) != 5 || b[4] != 0x0f {
		t.Fatalf("-1 encoding % x", b)
	}
	if _, err := ReadVarInt(bytes.NewReader([]byte{0xff, 0xff, 0xff, 0xff, 0xff, 0x01})); err == nil {
		t.Fatal("6-byte varint accepted")
	}
}

// fakeServer speaks just enough of the protocol to answer a status ping.
func fakeServer(t *testing.T, status string, pong bool) (string, int, *string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	gotHost := new(string)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				r := bufio.NewReader(c)
				id, hs, err := readPacket(r) // handshake
				if err != nil || id != 0 {
					return
				}
				br := bytes.NewReader(hs)
				ReadVarInt(br) // protocol
				l, _ := ReadVarInt(br)
				h := make([]byte, l)
				br.Read(h)
				*gotHost = string(h)
				if id, _, err := readPacket(r); err != nil || id != 0 { // status request
					return
				}
				body := WriteVarInt(nil, int32(len(status)))
				body = append(body, status...)
				c.Write(packet(0x00, body))
				id, p, err := readPacket(r)
				if err != nil || id != 0x01 || !pong {
					return
				}
				time.Sleep(2 * time.Millisecond)
				c.Write(packet(0x01, p))
			}(c)
		}
	}()
	addr := ln.Addr().(*net.TCPAddr)
	return "127.0.0.1", addr.Port, gotHost
}

func TestPingAgainstFakeServer(t *testing.T) {
	status := `{"version":{"name":"Paper 1.21.8","protocol":772},
	  "players":{"max":20,"online":2,"sample":[{"name":"Steve","id":"8667ba71-b85a-4004-af54-457a9734eed7"},{"name":"<b>x</b>","id":"x"}]},
	  "description":{"text":"","extra":[{"text":"A ","color":"gold"},{"text":"§aBlockForge","bold":true},{"translate":"k","fallback":" server"}]},
	  "favicon":"data:image/png;base64,AAAA","enforcesSecureChat":true}`
	host, port, gotHost := fakeServer(t, status, true)
	st, err := Ping(context.Background(), host, port, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if st.VersionName != "Paper 1.21.8" || *st.Protocol != 772 || st.PlayersOnline != 2 || st.PlayersMax != 20 ||
		len(st.PlayerSample) != 2 || st.PlayerSample[1].Name != "<b>x</b>" || st.Motd != "A BlockForge server" || st.LatencyMs <= 0 {
		t.Fatalf("status %+v", st)
	}
	if *gotHost != "127.0.0.1" {
		t.Fatalf("handshake host %q", *gotHost)
	}
	// Server that never answers the ping still yields a status (latency from status RTT).
	host2, port2, _ := fakeServer(t, `{"players":{"max":0,"online":0},"description":"§cLegacy §lMOTD"}`, false)
	st, err = Ping(context.Background(), host2, port2, time.Second)
	if err != nil || st.Motd != "Legacy MOTD" || len(st.PlayerSample) != 0 || st.PlayerSample == nil {
		t.Fatalf("no-pong: %v %+v", err, st)
	}
}

func TestPingErrors(t *testing.T) {
	host, port, _ := fakeServer(t, `{"version":{"name":"x"}}`, true)
	if _, err := Ping(context.Background(), host, port, time.Second); err == nil {
		t.Fatal("status without players accepted")
	}
	host, port, _ = fakeServer(t, `not json`, true)
	if _, err := Ping(context.Background(), host, port, time.Second); err == nil {
		t.Fatal("garbage accepted")
	}
	// Closed port → error quickly.
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	p := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	if _, err := Ping(context.Background(), "127.0.0.1", p, 500*time.Millisecond); err == nil {
		t.Fatal("closed port succeeded")
	}
	if _, err := ProbeTCP(context.Background(), "127.0.0.1", p, 500*time.Millisecond); err == nil {
		t.Fatal("tcp probe to closed port succeeded")
	}
	// Silent server → timeout, not a hang.
	ln2, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln2.Close()
	go func() {
		c, err := ln2.Accept()
		if err == nil {
			time.Sleep(3 * time.Second)
			c.Close()
		}
	}()
	start := time.Now()
	_, err := Ping(context.Background(), "127.0.0.1", ln2.Addr().(*net.TCPAddr).Port, 300*time.Millisecond)
	if err == nil || time.Since(start) > 2*time.Second {
		t.Fatalf("silent server: err=%v after %v", err, time.Since(start))
	}
}

func TestOversizedPacketRejected(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		r := bufio.NewReader(c)
		readPacket(r)
		readPacket(r)
		c.Write(WriteVarInt(nil, 64<<20)) // claims 64 MiB
		c.Write([]byte(strings.Repeat("x", 100)))
	}()
	_, err := Ping(context.Background(), "127.0.0.1", ln.Addr().(*net.TCPAddr).Port, time.Second)
	if err == nil || !strings.Contains(err.Error(), "invalid packet length") {
		t.Fatalf("oversized: %v", err)
	}
	_ = binary.BigEndian
}
