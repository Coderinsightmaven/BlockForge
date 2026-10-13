"""Minimal BlockForge API client for end-to-end runs against a dev control plane (stdlib only).

Credentials come from BF_EMAIL/BF_PASSWORD or the gitignored .data/dev-owner.txt written at setup.
Secrets are never printed.
"""

import http.cookiejar
import json
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
BASE = os.environ.get("BF_URL", "http://127.0.0.1:8080")


def _owner_file():
    """BF_OWNER_FILE, else the first .data/dev-owner.txt in the checkout or a parent directory
    (git worktrees under .claude/worktrees/ share the main checkout's file)."""
    if os.environ.get("BF_OWNER_FILE"):
        return pathlib.Path(os.environ["BF_OWNER_FILE"])
    for d in [ROOT, *ROOT.parents]:
        f = d / ".data" / "dev-owner.txt"
        if f.is_file():
            return f
    raise FileNotFoundError("no .data/dev-owner.txt found; set BF_EMAIL/BF_PASSWORD or BF_OWNER_FILE")


def _owner_creds():
    if os.environ.get("BF_EMAIL") and os.environ.get("BF_PASSWORD"):
        return os.environ["BF_EMAIL"], os.environ["BF_PASSWORD"]
    fields = {}
    for line in _owner_file().read_text().splitlines():
        if ": " in line:
            k, v = line.split(": ", 1)
            fields[k.strip()] = v.strip()
    return fields["email"], fields["password"]


class ApiError(Exception):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {body}")
        self.status = status
        self.body = body


class Client:
    def __init__(self, base=BASE):
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def _csrf(self):
        return next((c.value for c in self.jar if c.name == "bf_csrf"), None)

    def request(self, method, path, body=None, idempotent=False, raw=None, headers=None):
        """Returns (status, parsed JSON or None). Raises ApiError on >= 400."""
        h = dict(headers or {})
        data = None
        if raw is not None:
            data = raw
        elif body is not None:
            data = json.dumps(body).encode()
            h["content-type"] = "application/json"
        if method not in ("GET", "HEAD") and self._csrf():
            h["x-blockforge-csrf"] = self._csrf()
        if idempotent:
            h["idempotency-key"] = str(uuid.uuid4())
        req = urllib.request.Request(self.base + "/api/v1" + path, data=data, headers=h, method=method)
        try:
            with self.opener.open(req) as r:
                text = r.read().decode()
                return r.status, (json.loads(text) if text else None)
        except urllib.error.HTTPError as e:
            text = e.read().decode()
            try:
                parsed = json.loads(text)
            except ValueError:
                parsed = text
            raise ApiError(e.code, parsed) from None

    def get(self, path):
        return self.request("GET", path)[1]

    def post(self, path, body=None, **kw):
        return self.request("POST", path, body if body is not None else {}, **kw)[1]

    def put(self, path, body=None, **kw):
        return self.request("PUT", path, body, **kw)[1]

    def patch(self, path, body=None, **kw):
        return self.request("PATCH", path, body, **kw)[1]

    def delete(self, path, **kw):
        return self.request("DELETE", path, **kw)[1]

    def login(self):
        email, password = _owner_creds()
        self.post("/auth/login", {"email": email, "password": password})
        return self

    def wait_job(self, job_id, timeout=600, poll=1.0):
        """Polls GET /jobs/:id until it leaves queued/running; returns the job."""
        deadline = time.time() + timeout
        while True:
            job = self.get(f"/jobs/{job_id}")
            if job.get("status") not in ("queued", "running", "pending"):
                return job
            if time.time() > deadline:
                raise TimeoutError(f"job {job_id} still {job.get('status')} after {timeout}s")
            time.sleep(poll)

    def wait_job_ok(self, job_id, timeout=600, what="job"):
        """wait_job + assert succeeded (prints the job error otherwise)."""
        job = self.wait_job(job_id, timeout=timeout)
        if job.get("status") != "succeeded":
            raise AssertionError(f"{what} {job_id} ended {job.get('status')}: {json.dumps(job.get('error'))}")
        return job

    def expect_error(self, fn, status, code=None):
        """Runs fn(); asserts it raised ApiError with this status (and error code); returns the error body."""
        try:
            got = fn()
        except ApiError as e:
            err = e.body.get("error", {}) if isinstance(e.body, dict) else {}
            if e.status != status or (code is not None and err.get("code") != code):
                raise AssertionError(f"expected HTTP {status} {code or ''}, got HTTP {e.status}: {json.dumps(e.body)}") from None
            return err
        raise AssertionError(f"expected HTTP {status} {code or ''}, got success: {json.dumps(got)[:500]}")

    def put_transfer(self, url, data):
        """PUTs raw bytes to a transfer URL returned by the API (`/api/v1/transfers/<token>` or absolute)."""
        full = url if url.startswith("http") else self.base + url
        h = {"content-type": "application/octet-stream"}
        if self._csrf():
            h["x-blockforge-csrf"] = self._csrf()
        req = urllib.request.Request(full, data=data, headers=h, method="PUT")
        try:
            with self.opener.open(req) as r:
                text = r.read().decode()
                return r.status, (json.loads(text) if text else None)
        except urllib.error.HTTPError as e:
            raise ApiError(e.code, e.read().decode()) from None

    # --- servers -----------------------------------------------------------------------------

    def server(self, server_id):
        return self.get(f"/servers/{server_id}")

    def find_server(self, name):
        items = self.get("/servers?" + urllib.parse.urlencode({"q": name, "limit": 200}))["items"]
        return next((s for s in items if s["name"] == name), None)

    def wait_state(self, server_id, states, timeout=600, poll=2.0):
        """Waits until the server is in one of `states` with no active operation; returns the server."""
        states = (states,) if isinstance(states, str) else tuple(states)
        deadline = time.time() + timeout
        while True:
            s = self.server(server_id)
            if s["state"] in states and not s.get("activeOperation"):
                return s
            if s["state"] in ("provision_failed",) and "provision_failed" not in states:
                raise AssertionError(f"server {s['name']} is {s['state']}")
            if time.time() > deadline:
                raise TimeoutError(f"server {server_id} still {s['state']} (op {s.get('activeOperation')}) after {timeout}s")
            time.sleep(poll)

    def action(self, server_id, action, wait=True, timeout=600):
        """POST /servers/:id/actions; waits for the job to succeed."""
        r = self.post(f"/servers/{server_id}/actions", {"action": action}, idempotent=True)
        if wait:
            self.wait_job_ok(r["jobId"], timeout=timeout, what=f"{action} job")
        return r

    def ensure_running(self, server_id, timeout=600):
        s = self.wait_state(server_id, ("running", "stopped", "crashed", "degraded"), timeout=timeout)
        if s["state"] not in ("running",):
            self.action(server_id, "start", timeout=timeout)
            s = self.wait_state(server_id, "running", timeout=timeout)
        return s

    def ensure_stopped(self, server_id, timeout=300):
        s = self.wait_state(server_id, ("running", "stopped", "crashed", "degraded"), timeout=timeout)
        if s["state"] not in ("stopped", "crashed"):
            self.action(server_id, "stop", timeout=timeout)
            s = self.wait_state(server_id, ("stopped",), timeout=timeout)
        return s

    def console_seq(self, server_id):
        lines = self.get(f"/servers/{server_id}/console/history?lines=1")["lines"]
        return lines[-1]["seq"] if lines else -1

    def console_since(self, server_id, seq, lines=5000):
        out = self.get(f"/servers/{server_id}/console/history?lines={lines}")["lines"]
        return [l["line"] for l in out if l["seq"] > seq and l["stream"] != "system"]

    def console(self, server_id, command, expect=None, timeout=15.0):
        """Sends a console command; with `expect` (substring or callable(line)) waits for a matching line."""
        seq = self.console_seq(server_id)
        self.request("POST", f"/servers/{server_id}/console", {"command": command})
        if expect is None:
            return None
        match = expect if callable(expect) else (lambda l: expect in l)
        deadline = time.time() + timeout
        while True:
            for line in self.console_since(server_id, seq):
                if match(line):
                    return line
            if time.time() > deadline:
                raise AssertionError(f"no console line matching {expect!r} after `{command}`")
            time.sleep(0.5)

    def wait_console(self, server_id, seq, expect, timeout=180.0):
        match = expect if callable(expect) else (lambda l: expect in l)
        deadline = time.time() + timeout
        while True:
            for line in self.console_since(server_id, seq):
                if match(line):
                    return line
            if time.time() > deadline:
                raise AssertionError(f"no console line matching {expect!r} within {timeout}s")
            time.sleep(1)

    # --- files ---------------------------------------------------------------------------------

    def read_file(self, server_id, path):
        """GET /files/contents; returns the response (content, sha256, …) or None when the file is missing."""
        try:
            return self.get(f"/servers/{server_id}/files/contents?" + urllib.parse.urlencode({"path": path}))
        except ApiError as e:
            if e.status == 404:
                return None
            raise

    def write_file(self, server_id, path, content, encoding="utf8", base_sha256=False):
        body = {"path": path, "content": content, "encoding": encoding}
        if base_sha256 is not False:
            body["baseSha256"] = base_sha256
        return self.put(f"/servers/{server_id}/files/contents", body)

    def list_files(self, server_id, path=""):
        return self.get(f"/servers/{server_id}/files/list?" + urllib.parse.urlencode({"path": path}))["entries"]


def check(cond, what):
    """Records one assertion; raises with a readable message on failure."""
    if not cond:
        raise AssertionError(what)
    print(f"  ok  {what}")


def main(fn):
    """Runs fn(client); prints the failure (with the API error body) and exits non-zero on the first one."""
    import sys
    import traceback

    try:
        fn(Client().login())
    except ApiError as e:
        print(f"  FAIL  HTTP {e.status}: {json.dumps(e.body) if not isinstance(e.body, str) else e.body}")
        traceback.print_exc(limit=3)
        sys.exit(1)
    except (AssertionError, TimeoutError) as e:
        print(f"  FAIL  {e}")
        traceback.print_exc(limit=3)
        sys.exit(1)
    print("PASS")
