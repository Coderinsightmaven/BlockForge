package artifact

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/blockforge/node-agent/internal/config"
	"github.com/blockforge/node-agent/internal/fsops"
	"github.com/blockforge/node-agent/internal/protocol"
)

const wid = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"

var payload = []byte(strings.Repeat("paperclip-jar-bytes|", 5000))

func hexOf(h interface{ Sum([]byte) []byte }) string { return hex.EncodeToString(h.Sum(nil)) }

func sums() (s1, s256, s512 string) {
	a := sha1.New()
	a.Write(payload)
	b := sha256.New()
	b.Write(payload)
	c := sha512.New()
	c.Write(payload)
	return hexOf(a), hexOf(b), hexOf(c)
}

func setup(t *testing.T) (*httptest.Server, *Fetcher, *fsops.Root, string) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/file.jar", func(w http.ResponseWriter, r *http.Request) { w.Write(payload) })
	mux.HandleFunc("/redirect-ok", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/file.jar", http.StatusFound)
	})
	mux.HandleFunc("/missing", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	mux.HandleFunc("/stall", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000")
		w.Write([]byte("abc"))
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	})
	srv := httptest.NewTLSServer(mux)
	t.Cleanup(srv.Close)
	mux.HandleFunc("/redirect-evil", func(w http.ResponseWriter, r *http.Request) {
		// Same server, but addressed via a host name that is not on the allowlist.
		u, _ := url.Parse(srv.URL)
		http.Redirect(w, r, "https://localhost:"+u.Port()+"/file.jar", http.StatusFound)
	})
	mux.HandleFunc("/redirect-http", func(w http.ResponseWriter, r *http.Request) {
		u, _ := url.Parse(srv.URL)
		http.Redirect(w, r, "http://"+u.Host+"/file.jar", http.StatusFound)
	})
	u, _ := url.Parse(srv.URL)
	f := &Fetcher{
		Hosts:       config.NewHostAllowlist([]string{u.Host}), // 127.0.0.1:<port>
		Transport:   srv.Client().Transport,
		IdleTimeout: 300 * time.Millisecond,
	}
	s := &fsops.Sandbox{DataRoot: t.TempDir(), UID: 1000, GID: 1000}
	if err := s.EnsureDataDir(wid); err != nil {
		t.Fatal(err)
	}
	root, err := s.Open(wid)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { root.Close() })
	return srv, f, root, s.DataDir(wid)
}

func codeOf(err error) protocol.ErrorCode {
	if pe, ok := protocol.AsError(err); ok {
		return pe.Code
	}
	if err == nil {
		return ""
	}
	return protocol.ErrorCode("raw:" + err.Error())
}

func noTemps(t *testing.T, dir string) {
	t.Helper()
	filepath.Walk(dir, func(p string, fi os.FileInfo, _ error) error {
		if fi != nil && strings.Contains(fi.Name(), ".bf-tmp-") {
			t.Errorf("temp file left: %s", p)
		}
		return nil
	})
}

func TestFetchChecksums(t *testing.T) {
	srv, f, root, dir := setup(t)
	s1, s256, s512 := sums()
	for alg, sum := range map[string]string{"sha1": s1, "sha256": s256, "sha512": s512} {
		var calls int
		res, err := f.Fetch(context.Background(), root, &protocol.ArtifactFetchPayload{
			URL: srv.URL + "/redirect-ok", DestPath: "plugins/" + alg + ".jar",
			Checksum: &protocol.Checksum{Algorithm: alg, Value: sum}, MaxBytes: 1 << 20,
		}, func(done, total int64) { calls++ })
		if err != nil {
			t.Fatalf("%s: %v", alg, err)
		}
		if res.Bytes != int64(len(payload)) || res.Sha256 != s256 || calls == 0 {
			t.Fatalf("%s: %+v calls=%d", alg, res, calls)
		}
		b, _ := os.ReadFile(filepath.Join(dir, "plugins", alg+".jar"))
		if string(b) != string(payload) {
			t.Fatal("content mismatch")
		}
	}
	// checksum null: allowed, still reports sha256
	res, err := f.Fetch(context.Background(), root, &protocol.ArtifactFetchPayload{URL: srv.URL + "/file.jar", DestPath: "x.jar", MaxBytes: 1 << 20}, nil)
	if err != nil || res.Sha256 != s256 {
		t.Fatalf("no checksum: %v %+v", err, res)
	}
	noTemps(t, dir)
}

func TestFetchFailures(t *testing.T) {
	srv, f, root, dir := setup(t)
	_, s256, _ := sums()
	cases := []struct {
		name string
		p    protocol.ArtifactFetchPayload
		want protocol.ErrorCode
	}{
		{"mismatch", protocol.ArtifactFetchPayload{URL: srv.URL + "/file.jar", DestPath: "server.jar",
			Checksum: &protocol.Checksum{Algorithm: "sha256", Value: strings.Repeat("a", 64)}, MaxBytes: 1 << 20}, protocol.CodeChecksumMismatch},
		{"redirect to non-allowlisted host", protocol.ArtifactFetchPayload{URL: srv.URL + "/redirect-evil", DestPath: "server.jar", MaxBytes: 1 << 20}, protocol.CodeHostNotAllowed},
		{"redirect to http", protocol.ArtifactFetchPayload{URL: srv.URL + "/redirect-http", DestPath: "server.jar", MaxBytes: 1 << 20}, protocol.CodeHostNotAllowed},
		{"http refused", protocol.ArtifactFetchPayload{URL: strings.Replace(srv.URL, "https", "http", 1) + "/file.jar", DestPath: "server.jar", MaxBytes: 1 << 20}, protocol.CodeHostNotAllowed},
		{"host not allowlisted", protocol.ArtifactFetchPayload{URL: "https://example.com/file.jar", DestPath: "server.jar", MaxBytes: 1 << 20}, protocol.CodeHostNotAllowed},
		{"size limit", protocol.ArtifactFetchPayload{URL: srv.URL + "/file.jar", DestPath: "server.jar", MaxBytes: 1000}, protocol.CodeQuotaExceeded},
		{"not found", protocol.ArtifactFetchPayload{URL: srv.URL + "/missing", DestPath: "server.jar", MaxBytes: 1 << 20}, protocol.CodeDownloadFailed},
		{"stall", protocol.ArtifactFetchPayload{URL: srv.URL + "/stall", DestPath: "server.jar", MaxBytes: 1 << 20}, protocol.CodeDownloadFailed},
		{"root dest", protocol.ArtifactFetchPayload{URL: srv.URL + "/file.jar", DestPath: ".", MaxBytes: 1 << 20}, protocol.CodePathForbidden},
		{"traversal dest", protocol.ArtifactFetchPayload{URL: srv.URL + "/file.jar", DestPath: "../x.jar", MaxBytes: 1 << 20}, protocol.CodePathForbidden},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := c.p
			_, err := f.Fetch(context.Background(), root, &p, nil)
			if got := codeOf(err); got != c.want {
				t.Fatalf("want %s got %s (%v)", c.want, got, err)
			}
			if _, err := os.Stat(filepath.Join(dir, "server.jar")); err == nil {
				t.Fatal("destination written despite failure")
			}
		})
	}
	noTemps(t, dir)
	// Size limit via Content-Length is enforced before reading, and also without it (chunked).
	_ = s256
}

func TestTransfersPushPull(t *testing.T) {
	_, _, root, dir := setup(t)
	os.WriteFile(filepath.Join(dir, "world.zip"), payload, 0o644)
	var gotAuth, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		switch r.Method {
		case http.MethodPost:
			b, _ := io.ReadAll(r.Body)
			gotBody = string(b)
			w.WriteHeader(http.StatusNoContent)
		case http.MethodGet:
			if strings.HasSuffix(r.URL.Path, "/bad") {
				w.Header().Set("X-BlockForge-Sha256", strings.Repeat("0", 64))
			}
			w.Write(payload)
		}
	}))
	defer srv.Close()
	tr := &Transfers{Client: srv.Client(), URL: func(id string) string { return srv.URL + "/agent/v1/transfers/" + id },
		Auth: func() (string, error) { return "BFAgent test", nil }}
	_, s256, _ := sums()
	res, err := tr.Push(context.Background(), root, &protocol.FsTransferPushPayload{Path: "world.zip", TransferID: wid})
	if err != nil || res.Sha256 != s256 || gotBody != string(payload) || gotAuth != "BFAgent test" {
		t.Fatalf("push: %v %+v", err, res)
	}
	res, err = tr.Pull(context.Background(), root, &protocol.FsTransferPullPayload{Path: "uploads/in.zip", TransferID: wid, MaxBytes: 1 << 20})
	if err != nil || res.Sha256 != s256 {
		t.Fatalf("pull: %v %+v", err, res)
	}
	_, err = tr.Pull(context.Background(), root, &protocol.FsTransferPullPayload{Path: "uploads/small.zip", TransferID: wid, MaxBytes: 10})
	if codeOf(err) != protocol.CodeQuotaExceeded {
		t.Fatalf("pull limit: %v", err)
	}
	tr.URL = func(id string) string { return srv.URL + "/agent/v1/transfers/" + id + "/bad" }
	_, err = tr.Pull(context.Background(), root, &protocol.FsTransferPullPayload{Path: "uploads/bad.zip", TransferID: wid, MaxBytes: 1 << 20})
	if codeOf(err) != protocol.CodeChecksumMismatch {
		t.Fatalf("pull checksum: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "uploads", "bad.zip")); err == nil {
		t.Fatal("bad transfer committed")
	}
	noTemps(t, dir)
}
