package agent

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/blockforge/node-agent/internal/auth"
	"github.com/blockforge/node-agent/internal/fsops"
	"github.com/blockforge/node-agent/internal/protocol"
	"github.com/blockforge/node-agent/internal/transport"
)

// fs.hash and jar.readEntries through the real executor and handler table: registered, not
// serialised with mutations, and the result frame carries untrusted text without HTML escaping (the
// JSON-encoded size the agent budgets is the size on the wire).
func TestExtensionScansOverExecutor(t *testing.T) {
	sb := fsops.NewSandbox(t.TempDir(), 1000, 1000)
	if err := sb.EnsureDataDir(testWID); err != nil {
		t.Fatal(err)
	}
	var jar bytes.Buffer
	zw := zip.NewWriter(&jar)
	w, _ := zw.Create("plugin.yml")
	lineSep := string(rune(0x2028)) // sent as the 6-byte escape by the encoder
	w.Write([]byte("name: Demo\ndescription: <b>bold</b> & " + lineSep + " \"quoted\"\n"))
	zw.Close()
	if err := os.MkdirAll(filepath.Join(sb.DataDir(testWID), "plugins"), 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(sb.DataDir(testWID), "plugins", "Demo.jar"), jar.Bytes(), 0o644)

	cp, _ := auth.KeyFromSeedHex(cpSeed)
	a := &Agent{sandbox: sb}
	var mu sync.Mutex
	frames := map[string][]byte{}
	e := NewExecutor(context.Background(), 2)
	e.NodeID, e.CPKey, e.Log, e.Timeout = testNodeID, cp.Public().(ed25519.PublicKey), quietLogger(), commandTimeout
	e.Handlers = a.handlers()
	e.Send = func(it transport.Item) {
		var rf protocol.ResultFrame
		json.Unmarshal(it.Data, &rf)
		mu.Lock()
		frames[rf.ID] = it.Data
		mu.Unlock()
	}
	// A mutation holding the workload lock must not delay the read-only scans.
	unlock, err := e.lockWorkload(context.Background(), testWID)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()

	fake := &fakeCP{cp: cp}
	hashID, jarID := "00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2"
	e.Handle(fake.signCmd(hashID, protocol.CmdFsHash, map[string]any{"workloadId": testWID,
		"paths": []string{"plugins/Demo.jar", "plugins/none.jar"}, "algorithms": []string{"sha256"}, "maxBytesPerFile": 1 << 20}, time.Now(), time.Minute))
	e.Handle(fake.signCmd(jarID, protocol.CmdJarReadEntries, map[string]any{"workloadId": testWID,
		"paths": []string{"plugins/Demo.jar"}, "entries": []string{"plugin.yml", "paper-plugin.yml"}, "maxEntryBytes": 1024,
		"maxJarBytes": 1 << 20, "hash": []string{"sha1"}}, time.Now(), time.Minute))
	deadline := time.Now().Add(10 * time.Second)
	for {
		mu.Lock()
		n := len(frames)
		mu.Unlock()
		if n == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("scans did not finish while a mutation held the workload lock")
		}
		time.Sleep(10 * time.Millisecond)
	}

	var hr struct {
		OK   bool                  `json:"ok"`
		Data protocol.FsHashResult `json:"data"`
	}
	json.Unmarshal(frames[hashID], &hr)
	if !hr.OK || !hr.Data.Files[0].OK || len(hr.Data.Files[0].Sha256) != 64 || hr.Data.Files[1].Error != "NOT_FOUND" {
		t.Fatalf("fs.hash frame %s", frames[hashID])
	}
	raw := string(frames[jarID])
	bs := "\\" // a JSON escape sequence starts with a backslash
	if !strings.Contains(raw, "<b>bold</b> & "+bs+"u2028 "+bs+"\"quoted"+bs+"\"") || strings.Contains(raw, bs+"u003c") || strings.Contains(raw, bs+"u0026") {
		t.Fatalf("jar.readEntries frame escapes untrusted text: %s", raw)
	}
	var jr struct {
		OK   bool                          `json:"ok"`
		Data protocol.JarReadEntriesResult `json:"data"`
	}
	json.Unmarshal(frames[jarID], &jr)
	j := jr.Data.Jars[0]
	if !jr.OK || !j.OK || len(j.Sha1) != 40 || j.Sha512 != "" || len(j.Entries) != 1 || j.Missing[0] != "paper-plugin.yml" ||
		!strings.HasPrefix(j.Entries[0].Content, "name: Demo\n") {
		t.Fatalf("jar.readEntries frame %s", raw)
	}
	if commandTimeout(&Command{Type: protocol.CmdFsHash}) != time.Hour || commandTimeout(&Command{Type: protocol.CmdJarReadEntries}) != 30*time.Minute {
		t.Fatal("timeouts")
	}
}
