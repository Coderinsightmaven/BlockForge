package metrics

import (
	"bufio"
	"errors"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
)

// ListeningPorts returns the TCP ports in LISTEN state and the bound, unconnected UDP ports of the
// host network namespace, read from HOST_PROC/net/{tcp,tcp6,udp,udp6} (best effort; Linux only).
// With the agent in the host network namespace (systemd or compose network_mode: host) these are
// the host's sockets, including ports published by Docker's proxy.
func ListeningPorts() (tcp, udp []int, err error) {
	tcpSet, udpSet := map[int]bool{}, map[int]bool{}
	found := false
	for _, f := range []struct {
		name string
		set  map[int]bool
		udp  bool
	}{{"tcp", tcpSet, false}, {"tcp6", tcpSet, false}, {"udp", udpSet, true}, {"udp6", udpSet, true}} {
		fh, e := os.Open(HostProc("net", f.name))
		if e != nil {
			continue
		}
		found = true
		parseSockTable(fh, f.set, f.udp)
		fh.Close()
	}
	if !found {
		return nil, nil, errors.New("socket tables not available on this platform")
	}
	return sortedKeys(tcpSet), sortedKeys(udpSet), nil
}

// parseSockTable reads a /proc/net/{tcp,udp}[6] table.
func parseSockTable(r io.Reader, set map[int]bool, udp bool) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 4096), 64*1024)
	first := true
	for sc.Scan() {
		if first {
			first = false
			continue
		}
		fields := strings.Fields(sc.Text())
		if len(fields) < 4 {
			continue
		}
		local, remote, state := fields[1], fields[2], fields[3]
		if udp {
			// Bound but unconnected: remote port 0 (state 07 = TCP_CLOSE in the shared table).
			if !strings.HasSuffix(remote, ":0000") {
				continue
			}
		} else if state != "0A" { // TCP_LISTEN
			continue
		}
		i := strings.LastIndexByte(local, ':')
		if i < 0 {
			continue
		}
		port, err := strconv.ParseUint(local[i+1:], 16, 16)
		if err != nil || port == 0 {
			continue
		}
		set[int(port)] = true
	}
}

func sortedKeys(m map[int]bool) []int {
	out := make([]int, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Ints(out)
	return out
}
