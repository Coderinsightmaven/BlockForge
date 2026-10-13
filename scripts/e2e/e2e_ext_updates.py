"""Extension updates on the running Paper server (`e2e-paper`): update checks, Modrinth SHA-512 identification
of a jar copied in through the file manager, project route releases-only by default, and an end-to-end update:
install an older Chunky (pinned version, administrator override for the Minecraft version), see the update
offered, apply it through `POST …/extensions/updates/apply`, verify the new version replaced the old one.

    python3 scripts/e2e/e2e_ext_updates.py

The older jar for the file-manager copy is downloaded from the Modrinth CDN (in memory) and
checked against Modrinth's SHA-512 before it is uploaded. Leaves no Chunky* jar in plugins/.
"""

import hashlib
import json
import time
import urllib.request

import bf
from bf import check
from e2e_extensions import cleanup, ext_list, find, ours, scan
from setup_servers import ensure_paper

PROJECT = "chunky"
OLD_VERSION = "1.4.40"  # Chunky for 1.21.11–26.1.2 (does not list 26.3)
UA = "BlockForge-e2e/1.0 (scripts/e2e)"


def modrinth_version(number):
    req = urllib.request.Request(f"https://api.modrinth.com/v2/project/{PROJECT}/version?loaders=%5B%22paper%22%5D", headers={"user-agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        versions = json.load(r)
    v = next(v for v in versions if v["version_number"] == number)
    f = next(f for f in v["files"] if f["primary"]) if any(f["primary"] for f in v["files"]) else v["files"][0]
    return v, f


def download(f):
    """Downloads the file into memory (never written next to code) and verifies Modrinth's SHA-512."""
    req = urllib.request.Request(f["url"], headers={"user-agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    check(hashlib.sha512(data).hexdigest() == f["hashes"]["sha512"], f"downloaded {f['filename']} ({len(data)} bytes), SHA-512 matches Modrinth")
    return data


def run(c):
    print("e2e_ext_updates (running Paper)")
    s = ensure_paper(c, running=True)
    sid = s["id"]
    cleanup(c, sid)

    up = c.get(f"/servers/{sid}/extensions/updates")
    check(isinstance(up["checkedAt"], int) and isinstance(up["items"], list), f"GET extensions/updates 200 ({len(up['items'])} item(s))")

    # Project route: releases only unless allowPrerelease.
    pr = c.get(f"/servers/{sid}/extensions/modrinth/projects/luckperms")
    check(pr["versions"] and all(v["versionType"] == "release" for v in pr["versions"]),
          f"project luckperms: {len(pr['versions'])} version(s), all releases (newest {pr['versions'][0]['versionNumber']})")
    pre = c.get(f"/servers/{sid}/extensions/modrinth/projects/luckperms?allowPrerelease=true")
    check(len(pre["versions"]) >= len(pr["versions"]), f"allowPrerelease=true lists {len(pre['versions'])} version(s) ({sorted({v['versionType'] for v in pre['versions']})})")

    # Hash identification of a jar copied in through the file manager (as over SFTP).
    v_old, f_old = modrinth_version(OLD_VERSION)
    data = download(f_old)
    u = c.post(f"/servers/{sid}/files/upload-url", {"directory": "plugins", "fileName": f_old["filename"], "size": len(data)})
    status, _ = c.put_transfer(u["url"], data)
    check(200 <= status < 300, f"file manager upload of plugins/{f_old['filename']} -> {status}")
    scan(c, sid)
    e = find(ext_list(c, sid), lambda e: e["filename"] == f_old["filename"])
    check(e is not None and e["installedAt"] is None, "incremental scan found the copied jar (not installed by BlockForge)")
    check(e["sha512"] == f_old["hashes"]["sha512"], "scan hashed it (SHA-512 = Modrinth's)")
    m = e["modrinth"]
    check(m is not None and m["versionId"] == v_old["id"] and m["versionNumber"] == OLD_VERSION and m["slug"] == PROJECT,
          f"identified on Modrinth by hash: {m and m['title']} {m and m['versionNumber']} ({m and m['versionId']})")
    check(e["metadata"] and e["metadata"][0]["name"] == "Chunky", f"metadata read: Chunky {e['metadata'][0]['version']}")
    print(f"  ..  observation: source of the identified on-disk copy = {e['source']!r}")
    up = c.get(f"/servers/{sid}/extensions/updates")
    it = next((i for i in up["items"] if i["extensionId"] == e["id"]), None)
    check(it is not None and it["current"] and it["current"]["versionId"] == v_old["id"], "update check knows the copied jar's current version")
    check(it["updateAvailable"] and it["latest"] and it["latest"]["versionNumber"] != OLD_VERSION,
          f"update offered for the copied jar: {OLD_VERSION} -> {it['latest'] and it['latest']['versionNumber']}")
    rm = c.delete(f"/servers/{sid}/extensions/{e['id']}")
    check(f_old["filename"] not in [x["name"] for x in c.list_files(sid, "plugins")] and rm["historyEntryId"], "removed the copied jar again (keep area)")

    # Install the older version through the install route, then apply the update.
    req = {"project": PROJECT, "versionId": v_old["id"], "allowIncompatibleVersion": True}
    plan = c.post(f"/servers/{sid}/extensions/modrinth/plan", req)
    codes = sorted({w["code"] for w in plan["warnings"]})
    check(plan["installable"] and plan["files"][0]["versionNumber"] == OLD_VERSION, f"plan pinned {OLD_VERSION}: installable, warnings {codes}")
    expect = [{"projectId": f["projectId"], "versionId": f["versionId"], "action": f["action"]} for f in plan["files"]]
    r = c.post(f"/servers/{sid}/extensions/modrinth/install", dict(req, expect=expect), idempotent=True)
    c.wait_job_ok(r["jobId"], timeout=300, what="install old")
    old = find(ext_list(c, sid), lambda e: e["modrinth"] and e["modrinth"]["versionId"] == v_old["id"])
    check(old is not None and old["source"] == "modrinth", f"installed {old and old['path']} ({OLD_VERSION})")

    up = c.get(f"/servers/{sid}/extensions/updates")
    it = next((i for i in up["items"] if i["extensionId"] == old["id"]), None)
    check(it is not None and it["updateAvailable"] and it["problem"] is None and it["file"] is not None,
          f"update available: {OLD_VERSION} -> {it and it['latest'] and it['latest']['versionNumber']} ({it and it['file'] and it['file']['filename']})")
    new_file = it["file"]
    check(new_file["action"] == "replace" and old["path"] in new_file["replaces"], f"update file replaces {old['path']}")

    t0 = time.time()
    r = c.post(f"/servers/{sid}/extensions/updates/apply", {"extensionIds": [old["id"]]}, idempotent=True)
    job = c.wait_job_ok(r["jobId"], timeout=300, what="apply updates")
    check(True, f"apply-updates job succeeded in {time.time() - t0:.1f}s; result {json.dumps(job.get('result'))[:300]}")
    lst = ext_list(c, sid)
    chunky = [x for x in lst["items"] if x["filename"].lower().startswith("chunky")]
    names = [x["name"] for x in c.list_files(sid, "plugins")]
    check(len(chunky) == 1 and chunky[0]["modrinth"]["versionId"] == new_file["versionId"], f"after apply: one Chunky, version {chunky and chunky[0]['modrinth']['versionNumber']}")
    check(chunky[0]["sha512"] == new_file["sha512"] and new_file["filename"] in names and old["filename"] not in names,
          f"plugins/ has {new_file['filename']} (verified SHA-512), {old['filename']} gone")
    hist = c.get(f"/servers/{sid}/extensions/history?limit=5")
    h = hist["items"][0]
    check(h["action"] == "update" and h["status"] == "succeeded" and h["from"]["versionNumber"] == OLD_VERSION and h["to"]["versionNumber"] == new_file["versionNumber"],
          f"history: update {h['from'] and h['from']['versionNumber']} -> {h['to'] and h['to']['versionNumber']}, rollback.available {h['rollback']['available']}")
    up = c.get(f"/servers/{sid}/extensions/updates")
    it = next((i for i in up["items"] if i["extensionId"] == chunky[0]["id"]), None)
    check(it is not None and not it["updateAvailable"], "update check afterwards: current, no update")

    cleanup(c, sid)
    check(not ours(ext_list(c, sid)), "cleanup: no Chunky extension left")


if __name__ == "__main__":
    bf.main(run)
