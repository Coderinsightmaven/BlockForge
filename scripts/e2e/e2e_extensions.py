"""Plugins on the running Paper server (`e2e-paper`): scan, Modrinth search/project/plan/install (Chunky),
disable/enable, upload of a generated plugin jar, remove → keep area → history → rollback, restart (Paper
loads Chunky), cleanup.

    python3 scripts/e2e/e2e_extensions.py

Always (also after a failure or Ctrl-C) removes every Chunky*/BfE2E* jar from plugins/ (moved to the keep
area), also after an interrupted earlier run. Leaves e2e-paper running (restarted once).
"""

import io
import time
import zipfile

import bf
from bf import check
from setup_servers import ensure_paper

PROJECT = "chunky"
UPLOAD_NAME = "BfE2E-1.0.0.jar"
OURS = ("chunky", "bfe2e")


def make_plugin_jar(name="BfE2E", version="1.0.0"):
    """A minimal Bukkit/Paper plugin jar: metadata only (no classes), so it must never be loaded by a start."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\r\nCreated-By: BlockForge e2e\r\n\r\n")
        z.writestr(
            "plugin.yml",
            f"name: {name}\nversion: '{version}'\nmain: dev.blockforge.e2e.{name}\napi-version: '1.21'\n"
            "description: BlockForge e2e upload test\nauthors: [BlockForge]\n",
        )
    return buf.getvalue()


def ext_list(c, sid):
    return c.get(f"/servers/{sid}/extensions")


def ours(lst):
    return [e for e in lst["items"] if e["filename"].lower().startswith(OURS)]


def _retry_busy(fn, timeout=120):
    """Retries fn() while the server is busy with another extension job (409) — e.g. after an interrupted run."""
    deadline = time.time() + timeout
    while True:
        try:
            return fn()
        except bf.ApiError as e:
            if e.status != 409 or time.time() > deadline:
                raise
            time.sleep(3)


def scan(c, sid, full=False):
    r = _retry_busy(lambda: c.post(f"/servers/{sid}/extensions/scan", {"full": full}, idempotent=True))
    return c.wait_job_ok(r["jobId"], timeout=300, what="scan")


def remove_ours(c, sid):
    """Removes every Chunky*/BfE2E* extension (moved to the keep area); idempotent, verifies the result."""
    scan(c, sid)
    for e in ours(ext_list(c, sid)):
        _retry_busy(lambda: c.delete(f"/servers/{sid}/extensions/{e['id']}"))
        print(f"  ..  cleanup: removed {e['path']}")
    left = [e["path"] for e in ours(ext_list(c, sid))]
    if left:
        raise AssertionError(f"cleanup could not remove {left} from server {sid}")


def cleanup(c):
    """Runs after every run (bf.main), also after a failure or Ctrl-C."""
    from setup_servers import PAPER_NAME

    s = c.find_server(PAPER_NAME)
    if s is not None:
        remove_ours(c, s["id"])


def find(lst, pred):
    return next((e for e in lst["items"] if pred(e)), None)


def run(c):
    print("e2e_extensions (running Paper)")
    s = ensure_paper(c, running=True)
    sid = s["id"]
    remove_ours(c, sid)

    lst = ext_list(c, sid)
    check(lst["installDir"] == "plugins" and lst["kind"] == "plugin", "extension list: plugins/ on Paper")
    t0 = time.time()
    job = scan(c, sid, full=True)
    check(True, f"full scan job succeeded in {time.time() - t0:.1f}s")
    lst = ext_list(c, sid)
    check(lst["scan"]["status"] == "completed" and lst["scan"]["jobId"] == job["id"] and lst["scan"]["error"] is None, "scan status completed (this job, no error)")
    check(not ours(lst), "no Chunky/BfE2E jar before the run")

    sr = c.get(f"/servers/{sid}/extensions/modrinth/search?query=chunky&limit=10")
    hit = next((h for h in sr["hits"] if h["slug"] == PROJECT), None)
    check(hit is not None and hit["loaderMatch"] == "match", f"Modrinth search 'chunky': {len(sr['hits'])} hits, chunky matches Paper")

    pr = c.get(f"/servers/{sid}/extensions/modrinth/projects/{PROJECT}")
    check(pr["project"]["compatible"] and pr["project"]["slug"] == PROJECT, f"project {pr['project']['title']} compatible")
    check(pr["versions"] and all(v["versionType"] == "release" for v in pr["versions"]), f"project versions: {len(pr['versions'])}, releases only")

    plan = c.post(f"/servers/{sid}/extensions/modrinth/plan", {"project": PROJECT})
    errors = [w for w in plan["warnings"] if w["level"] == "error"]
    check(plan["installable"] and not errors and len(plan["files"]) >= 1, f"plan: installable, {len(plan['files'])} file(s), {len(plan['warnings'])} warning(s)")
    check(plan["restartRequired"] is True, "plan: restartRequired (server running)")
    f0 = next(f for f in plan["files"] if f["reason"] == "requested")
    print(f"  ..  plan: {f0['filename']} {f0['versionNumber']} -> {f0['destPath']}")

    expect = [{"projectId": f["projectId"], "versionId": f["versionId"], "action": f["action"]} for f in plan["files"]]
    t0 = time.time()
    r = c.post(f"/servers/{sid}/extensions/modrinth/install", {"project": PROJECT, "expect": expect}, idempotent=True)
    job = c.wait_job_ok(r["jobId"], timeout=300, what="install")
    check(True, f"install job succeeded in {time.time() - t0:.1f}s (steps: {', '.join(st['key'] for st in job['steps'])})")
    lst = ext_list(c, sid)
    ch = find(lst, lambda e: e["filename"] == f0["filename"])
    check(ch is not None and ch["source"] == "modrinth" and ch["enabled"], f"{f0['filename']} installed, source modrinth, enabled")
    check(ch["sha512"] == f0["sha512"], "installed file SHA-512 equals the plan's (verified fetch)")
    check(ch["metadata"] and ch["metadata"][0]["name"] == "Chunky", f"metadata: {ch['metadata'][0]['name']} {ch['metadata'][0]['version']}")
    check(ch["compatibility"] and ch["compatibility"]["loadable"], "compatibility: loadable")
    check(ch["modrinth"] and ch["modrinth"]["versionId"] == f0["versionId"], "modrinth ref = installed version")

    r = c.patch(f"/servers/{sid}/extensions/{ch['id']}", {"enabled": False})
    check(r["extension"]["path"].endswith(".jar.disabled") and not r["extension"]["enabled"] and r["restartRequired"], f"disable -> {r['extension']['path']}")
    names = [e["name"] for e in c.list_files(sid, "plugins")]
    check(f0["filename"] + ".disabled" in names and f0["filename"] not in names, "file manager shows the .jar.disabled file")
    r = c.patch(f"/servers/{sid}/extensions/{ch['id']}", {"enabled": True})
    check(r["extension"]["path"] == f"plugins/{f0['filename']}" and r["extension"]["enabled"] and r["extension"]["id"] == ch["id"], "enable -> .jar again (same id)")

    data = make_plugin_jar()
    up = c.post(f"/servers/{sid}/extensions/uploads", {"filename": UPLOAD_NAME, "sizeBytes": len(data)})
    status, _ = c.put_transfer(up["url"], data)
    check(200 <= status < 300, f"transfer PUT {len(data)} bytes -> {status}")
    done = c.post(f"/servers/{sid}/extensions/uploads/{up['uploadId']}/complete", {})
    ue = done["extension"]
    check(ue["source"] == "upload" and ue["path"] == f"plugins/{UPLOAD_NAME}", f"upload completed: {ue['path']} source {ue['source']}")
    check(ue["metadata"] and ue["metadata"][0]["name"] == "BfE2E" and ue["metadata"][0]["version"] == "1.0.0", "upload metadata parsed: BfE2E 1.0.0")
    check(done["compatibility"]["loadable"], f"upload compatible (problems: {[p['code'] for p in done['compatibility']['problems']]})")

    rm = c.delete(f"/servers/{sid}/extensions/{ue['id']}")
    check(rm["rollbackAvailable"] and rm["restartRequired"], "remove upload: rollbackAvailable, restartRequired")
    check(UPLOAD_NAME not in [e["name"] for e in c.list_files(sid, "plugins")], "upload jar gone from plugins/ (moved to the keep area)")
    hist = c.get(f"/servers/{sid}/extensions/history?limit=20")
    entry = next((h for h in hist["items"] if h["id"] == rm["historyEntryId"]), None)
    check(entry is not None and entry["action"] == "remove" and entry["rollback"]["available"], "history: remove entry, rollback.available")
    r = c.post(f"/servers/{sid}/extensions/history/{entry['id']}/rollback", {}, idempotent=True)
    c.wait_job_ok(r["jobId"], timeout=300, what="rollback")
    back = find(ext_list(c, sid), lambda e: e["filename"] == UPLOAD_NAME)
    check(back is not None and back["sha512"] == ue["sha512"], "rollback job restored the upload (same SHA-512)")
    hist = c.get(f"/servers/{sid}/extensions/history?limit=5")
    check(hist["items"][0]["action"] == "rollback" and hist["items"][0]["status"] == "succeeded", "history: rollback entry recorded")

    # The generated jar has no classes: remove it before the restart so Paper never tries to load it.
    c.delete(f"/servers/{sid}/extensions/{back['id']}")
    check(UPLOAD_NAME not in [e["name"] for e in c.list_files(sid, "plugins")], "removed the upload again before the restart")

    seq = c.console_seq(sid)
    c.action(sid, "restart", timeout=600)
    c.wait_state(sid, bf.LIVE_STATES, timeout=600)
    line = c.wait_console(sid, seq, "[Chunky] Enabling Chunky", timeout=180)
    check(True, f"after restart Paper says {line.split(']: ')[-1]!r}")

    remove_ours(c, sid)
    check(not ours(ext_list(c, sid)), "cleanup: no Chunky/BfE2E extension left")


if __name__ == "__main__":
    bf.main(run, cleanup)
