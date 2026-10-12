package metrics

import (
	"net"
	"runtime"
	"strings"
	"testing"
)

func TestParseSockTable(t *testing.T) {
	tcp := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
		"   0: 00000000:63DD 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0\n" +
		"   1: 0100007F:46A0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2 1 0\n" +
		"   2: 0100007F:46A0 0100007F:D1A2 01 00000000:00000000 00:00000000 00000000  1000        0 3 1 0\n"
	udp := "  sl  local_address rem_address   st\n" +
		"  10: 00000000:8655 00000000:0000 07 0\n" +
		"  11: 0100007F:A3F1 0100007F:0035 01 0\n"
	ts, us := map[int]bool{}, map[int]bool{}
	parseSockTable(strings.NewReader(tcp), ts, false)
	parseSockTable(strings.NewReader(udp), us, true)
	if got := sortedKeys(ts); len(got) != 2 || got[0] != 18080 || got[1] != 25565 {
		t.Fatalf("tcp %v", got)
	}
	if got := sortedKeys(us); len(got) != 1 || got[0] != 34389 {
		t.Fatalf("udp %v", got)
	}
}

func TestListeningPortsLive(t *testing.T) {
	if runtime.GOOS != "linux" {
		if _, _, err := ListeningPorts(); err == nil {
			t.Fatal("expected not-available error off Linux")
		}
		return
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	tcp, udp, err := ListeningPorts()
	if err != nil {
		t.Fatal(err)
	}
	has := func(xs []int, p int) bool {
		for _, x := range xs {
			if x == p {
				return true
			}
		}
		return false
	}
	if !has(tcp, ln.Addr().(*net.TCPAddr).Port) || !has(udp, pc.LocalAddr().(*net.UDPAddr).Port) {
		t.Fatalf("tcp %v udp %v", tcp, udp)
	}
}
