//go:build integration && linux

package agent

import (
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/blockforge/node-agent/internal/enroll"
	"github.com/blockforge/node-agent/internal/protocol"
)

// s3Multipart is an httptest TLS server acting as S3: PUT ?partNumber=N&X-Amz-Signature=… stores a
// part (ETag "md5"), GET serves the completed object.
type s3Multipart struct {
	srv    *httptest.Server
	mu     sync.Mutex
	parts  map[int][]byte
	object []byte
}

func newS3Multipart(t *testing.T) *s3Multipart {
	s := &s3Multipart{parts: map[int][]byte{}}
	s.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("X-Amz-Signature") == "" {
			w.WriteHeader(403)
			return
		}
		switch r.Method {
		case http.MethodPut:
			n, _ := strconv.Atoi(r.URL.Query().Get("partNumber"))
			b, _ := io.ReadAll(r.Body)
			if int64(len(b)) != r.ContentLength {
				w.WriteHeader(400)
				return
			}
			s.mu.Lock()
			s.parts[n] = b
			s.mu.Unlock()
			sum := md5.Sum(b)
			w.Header().Set("ETag", `"`+hex.EncodeToString(sum[:])+`"`)
		case http.MethodGet:
			s.mu.Lock()
			obj := s.object
			s.mu.Unlock()
			w.Header().Set("Content-Length", strconv.Itoa(len(obj)))
			w.Write(obj)
		}
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *s3Multipart) url(q string) string {
	return s.srv.URL + "/bucket/blockforge/backup.tar.gz?" + q + "&X-Amz-Signature=presigned"
}

func sha256File(t *testing.T, p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// TestPaperBackupRestoreEndToEnd: real Paper data dir → backup.create (while running, after
// save-all) → backup.upload as S3 multipart (part bytes + ETags verified) → grief → backup.restore
// from the presigned URL with truncate → the server starts with the world intact.
func TestPaperBackupRestoreEndToEnd(t *testing.T) {
	root := os.Getenv("BF_IT_DATA_ROOT")
	if root == "" || os.Getenv("BF_IT_PAPER") != "1" {
		t.Skip("set BF_IT_DATA_ROOT and BF_IT_PAPER=1")
	}
	cp := newFakeCP(t)
	s3 := newS3Multipart(t)
	dataRoot := filepath.Join(root, "bkp-"+randomUUID()[:8])
	dir := filepath.Join(t.TempDir(), "config")
	cfg, err := enroll.Run(context.Background(), enroll.Options{
		URL: cp.srv.URL, Token: "bfe_0123456789abcdef_" + protocol.B64.EncodeToString(make([]byte, 32)),
		ConfigDir: dir, DataRoot: dataRoot, InsecureAllowHTTP: true, WorkloadUID: 1000, WorkloadGID: 1000, HTTPClient: cp.srv.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg.SFTP.Listen = "127.0.0.1:0"
	cfg.Save(dir)
	defer os.RemoveAll(dataRoot)
	startAgentWith(t, cp, dir, func(a *Agent) { a.BackupTransport = s3.srv.Client().Transport })
	cp.waitFrame(60*time.Second, func(m map[string]any) bool { return m["t"] == "hello" })

	r := &eggRun{t: t, cp: cp, wid: randomUUID()}
	defer r.cleanup()
	resp, err := http.Get("https://fill.papermc.io/v3/projects/paper/versions/1.21.8/builds/latest")
	if err != nil {
		t.Fatal(err)
	}
	var build struct {
		Downloads map[string]struct {
			URL       string            `json:"url"`
			Checksums map[string]string `json:"checksums"`
		} `json:"downloads"`
	}
	json.NewDecoder(resp.Body).Decode(&build)
	resp.Body.Close()
	dl := build.Downloads["server:default"]
	r.do("workload.ensure", map[string]any{
		"workloadId": r.wid, "kind": "minecraft", "image": "eclipse-temurin:21-jre",
		"command": []string{"java", "-Xms512M", "-Xmx1024M", "-jar", "server.jar", "nogui"}, "env": map[string]string{"TZ": "UTC"},
		"memoryLimitBytes": 2 << 30, "cpuLimitMillicores": 2000,
		"ports": []map[string]any{{"containerPort": 25565, "hostPort": 25575, "hostIp": "127.0.0.1", "protocol": "tcp"}},
		"stop":  map[string]any{"type": "command", "command": "stop"}, "stopTimeoutMs": 60000,
		"restartPolicy": map[string]any{"mode": "never"}, "jvmProbe": false,
	}, 10*time.Minute)
	r.do("artifact.fetch", map[string]any{"workloadId": r.wid, "url": dl.URL, "destPath": "server.jar",
		"checksum": map[string]any{"algorithm": "sha256", "value": dl.Checksums["sha256"]}, "maxBytes": 256 << 20}, 10*time.Minute)
	r.do("fs.write", map[string]any{"workloadId": r.wid, "path": "eula.txt", "content": "eula=true\n", "encoding": "utf8"}, time.Minute)
	r.do("fs.write", map[string]any{"workloadId": r.wid, "path": "server.properties", "encoding": "utf8",
		"content": "server-port=25565\nlevel-type=minecraft\\:flat\nview-distance=4\nsimulation-distance=4\nmotd=Backup IT\n"}, time.Minute)
	r.do("workload.start", map[string]any{"workloadId": r.wid}, 5*time.Minute)
	r.waitLog("workload", "Done (", 8*time.Minute)
	r.do("fs.write", map[string]any{"workloadId": r.wid, "path": "world/bf-marker.txt", "content": "before backup\n", "encoding": "utf8"}, time.Minute)
	// Consistent backup of a running server: save-off, save-all flush, archive, save-on.
	r.do("workload.console", map[string]any{"workloadId": r.wid, "line": "save-off"}, time.Minute)
	r.waitLog("workload", "Automatic saving is now disabled", time.Minute)
	r.do("workload.console", map[string]any{"workloadId": r.wid, "line": "save-all flush"}, time.Minute)
	r.waitLog("workload", "Saved the game", time.Minute)
	data := filepath.Join(dataRoot, "servers", r.wid, "data")
	levelSha := sha256File(t, filepath.Join(data, "world", "level.dat"))

	// Backup while the server runs; restore is refused while it runs.
	backupID := randomUUID()
	cr := r.do("backup.create", map[string]any{"workloadId": r.wid, "backupId": backupID, "ignore": []string{"logs/", "cache/"},
		"maxBytes": 1 << 30}, 10*time.Minute)
	size := int64(cr["sizeBytes"].(float64))
	t.Logf("backup.create: %d bytes, %v files, sha256 %v, %vms", size, cr["files"], cr["sha256"], cr["durationMs"])
	f := cp.signCmd(nextID(), "backup.restore", map[string]any{"workloadId": r.wid, "backupId": backupID, "source": map[string]any{"type": "local"},
		"sha256": cr["sha256"], "truncate": true, "maxTotalBytes": 1 << 30}, time.Now(), time.Minute)
	var fb struct{ ID string }
	json.Unmarshal([]byte(f.Body), &fb)
	cp.send(f)
	if res := cp.result(fb.ID, time.Minute); errCode(res) != "BUSY" {
		t.Fatalf("restore while running: %v", res)
	}
	r.do("workload.console", map[string]any{"workloadId": r.wid, "line": "save-on"}, time.Minute)
	r.do("workload.stop", map[string]any{"workloadId": r.wid, "timeoutMs": 60000}, 3*time.Minute)
	if sha256File(t, filepath.Join(data, "world", "level.dat")) == levelSha {
		t.Log("note: level.dat unchanged by shutdown")
	}

	// Upload as S3 multipart (5 MiB parts).
	const partSize = 5 << 20
	n := int((size + partSize - 1) / partSize)
	parts := []map[string]any{}
	for i := 1; i <= n; i++ {
		parts = append(parts, map[string]any{"partNumber": i, "url": s3.url(fmt.Sprintf("partNumber=%d&uploadId=up1", i))})
	}
	up := r.do("backup.upload", map[string]any{"workloadId": r.wid, "backupId": backupID, "partSize": partSize, "parts": parts,
		"deleteLocal": true}, 10*time.Minute)
	got := up["parts"].([]any)
	if len(got) != n {
		t.Fatalf("%d etags for %d parts", len(got), n)
	}
	var object []byte
	nums := []int{}
	for k := range s3.parts {
		nums = append(nums, k)
	}
	sort.Ints(nums)
	for i, k := range nums {
		b := s3.parts[k]
		sum := md5.Sum(b)
		e := got[i].(map[string]any)
		if int(e["partNumber"].(float64)) != k || e["etag"] != `"`+hex.EncodeToString(sum[:])+`"` {
			t.Fatalf("part %d: etag %v", k, e)
		}
		if k < n && len(b) != partSize {
			t.Fatalf("part %d has %d bytes", k, len(b))
		}
		object = append(object, b...)
	}
	objSum := sha256.Sum256(object)
	if hex.EncodeToString(objSum[:]) != cr["sha256"] {
		t.Fatal("reassembled object does not match the backup sha256")
	}
	t.Logf("backup.upload: %d parts, reassembled object sha256 matches", n)
	if _, err := os.Stat(filepath.Join(dataRoot, "backups", r.wid, backupID+".tar.gz")); err == nil {
		t.Fatal("deleteLocal did not remove the local archive")
	}
	s3.mu.Lock()
	s3.object = object
	s3.mu.Unlock()

	// Grief the server, then restore from the presigned URL with truncate.
	r.do("fs.delete", map[string]any{"workloadId": r.wid, "path": "world", "recursive": true}, time.Minute)
	r.do("fs.write", map[string]any{"workloadId": r.wid, "path": "griefed.txt", "content": "x", "encoding": "utf8"}, time.Minute)
	rs := r.do("backup.restore", map[string]any{"workloadId": r.wid, "backupId": backupID,
		"source": map[string]any{"type": "url", "url": s3.url("x-id=GetObject")}, "sha256": cr["sha256"], "truncate": true,
		"maxTotalBytes": 1 << 30}, 10*time.Minute)
	t.Logf("backup.restore: %v files, %v bytes, %vms", rs["files"], rs["bytes"], rs["durationMs"])
	if sha256File(t, filepath.Join(data, "world", "level.dat")) != levelSha {
		t.Fatal("level.dat differs after restore")
	}
	if b, _ := os.ReadFile(filepath.Join(data, "world", "bf-marker.txt")); string(b) != "before backup\n" {
		t.Fatal("marker missing after restore")
	}
	if _, err := os.Stat(filepath.Join(data, "griefed.txt")); err == nil {
		t.Fatal("truncate left the griefed file")
	}
	if fi, err := os.Stat(filepath.Join(data, "world", "level.dat")); err != nil || fi.Sys().(*syscall.Stat_t).Uid != 1000 {
		t.Fatalf("restored files not owned by the workload user: %v", err)
	}
	if es, _ := os.ReadDir(filepath.Join(dataRoot, "backups", ".tmp")); len(es) != 0 {
		t.Fatal("restore download temp file left")
	}
	// Staged restore: the data directory was swapped; no staging copy, old data or journal remains,
	// and the agent area (.blockforge/) came over from the previous data directory.
	es, _ := os.ReadDir(filepath.Dir(data))
	for _, e := range es {
		if strings.HasPrefix(e.Name(), "data.") || e.Name() == "restore.journal" {
			t.Fatalf("restore left %s in the workload directory", e.Name())
		}
	}
	if fi, err := os.Stat(filepath.Join(data, ".blockforge")); err != nil || !fi.IsDir() {
		t.Fatal(".blockforge/ missing after the swap")
	}
	// The restored server starts and answers SLP.
	r.do("workload.start", map[string]any{"workloadId": r.wid}, 5*time.Minute)
	r.waitLog("workload", "Done (", 8*time.Minute)
	probe := r.do("node.probe", map[string]any{"host": "127.0.0.1", "port": 25575, "kind": "minecraft", "timeoutMs": 5000}, time.Minute)
	if mc := probe["minecraft"].(map[string]any); probe["reachable"] != true || !strings.Contains(fmt.Sprint(mc["motd"]), "Backup IT") {
		t.Fatalf("probe after restore: %v", probe)
	}
	r.do("workload.stop", map[string]any{"workloadId": r.wid, "timeoutMs": 60000}, 3*time.Minute)
	r.do("backup.delete", map[string]any{"workloadId": r.wid, "backupId": backupID}, time.Minute) // idempotent (already deleted)
	t.Logf("restored server started, world intact (level.dat sha256 %s)", levelSha[:16])
}
