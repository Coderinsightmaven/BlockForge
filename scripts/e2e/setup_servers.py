"""Creates (or finds) the two e2e servers on the test node and waits until they run.

* `e2e-paper`   — built-in Minecraft template, Paper 26.3 (latest stable build), 1.5 GiB.
* `e2e-vanilla` — the official Pterodactyl "Vanilla Minecraft" egg (imported from
  packages/eggs/test/fixtures/eggs/ptero-egg-vanilla-minecraft.json when no such template exists),
  VANILLA_VERSION 26.3, 1.5 GiB; the EULA is accepted through the file manager API (eula.txt).

New servers get an explicit allocation (the lowest free one outside bf.FORBIDDEN_PORTS); every server is
checked against bf.FORBIDDEN_PORTS before it is started, also when reused (fail closed).

Other scripts import `ensure_paper` / `ensure_vanilla`. Run directly to set up both (leaves both running):
    python3 scripts/e2e/setup_servers.py
Env: BF_NODE (node name, default test-node), BF_URL, BF_EMAIL/BF_PASSWORD or .data/dev-owner.txt.
"""

import json
import os
import pathlib
import urllib.parse

import bf
from bf import check

ROOT = pathlib.Path(__file__).resolve().parents[2]
NODE_NAME = os.environ.get("BF_NODE", "test-node")
PAPER_NAME = "e2e-paper"
VANILLA_NAME = "e2e-vanilla"
PAPER_VERSION = "26.3"
VANILLA_VERSION = "26.3"
MEMORY = 1536 * 1024 * 1024
EGG_FILE = ROOT / "packages" / "eggs" / "test" / "fixtures" / "eggs" / "ptero-egg-vanilla-minecraft.json"
# Fields that identify the official Pterodactyl Vanilla Minecraft egg (compared with the fixture's import preview).
EGG_IDENTITY = ("name", "kind", "game", "author", "sourceFormat", "startup", "dockerImages", "install", "features")


def _node_id(c):
    nodes = c.get("/nodes")
    node = next((n for n in nodes if n["name"] == NODE_NAME), None)
    check(node is not None and node["connection"] == "online", f"node {NODE_NAME} exists and is online")
    return node["id"]


def _free_allocation(c, node_id):
    """Lowest free allocation of the node outside bf.FORBIDDEN_PORTS (never left to auto placement)."""
    items, cursor = [], None
    while True:
        q = {"free": "true", "limit": 500, **({"cursor": cursor} if cursor else {})}
        page = c.get(f"/nodes/{node_id}/allocations?" + urllib.parse.urlencode(q))
        items += page["items"]
        cursor = page.get("nextCursor")
        if not cursor:
            break
    ok = sorted((a for a in items if a["serverId"] is None and a["port"] not in bf.FORBIDDEN_PORTS), key=lambda a: a["port"])
    check(bool(ok), f"node has a free allocation outside {sorted(bf.FORBIDDEN_PORTS)}")
    return ok[0]


def _placement(c):
    """`placement` + explicit `allocation` for POST /servers."""
    node_id = _node_id(c)
    a = _free_allocation(c, node_id)
    print(f"  ..  using allocation {a['ip']}:{a['port']} ({a['id']})")
    return {"placement": {"mode": "node", "nodeId": node_id}, "allocation": {"mode": "specific", "allocationId": a["id"]}}


def _guard(s):
    ports = bf.guard_ports(s)
    check(True, f"{s['name']} allocation port(s) {ports} avoid {sorted(bf.FORBIDDEN_PORTS)}")


def _create(c, body, what):
    r = c.post("/servers", body, idempotent=True)
    sid = r["server"]["id"]
    print(f"  ..  created {what} {sid}, provisioning (job {r['jobId']})")
    c.wait_job_ok(r["jobId"], timeout=900, what=f"{what} provision")
    return sid


def ensure_paper(c, running=True):
    s = c.find_server(PAPER_NAME)
    if s is None:
        tpl = next(t for t in c.get("/templates") if t["key"] == "minecraft-java")
        sid = _create(
            c,
            {
                "name": PAPER_NAME,
                "slug": PAPER_NAME,
                "description": "BlockForge e2e (scripts/e2e)",
                "templateId": tpl["id"],
                **_placement(c),
                "memoryLimitBytes": MEMORY,
                "startup": "manual",
                "restartPolicy": {"mode": "never"},
                "minecraft": {"software": "paper", "version": PAPER_VERSION, "acceptEula": True},
            },
            PAPER_NAME,
        )
        s = c.server(sid)
    else:
        print(f"  ..  reusing {PAPER_NAME} {s['id']} ({s['state']})")
    check(s["software"] == "paper" and s["minecraftVersion"] == PAPER_VERSION, f"{PAPER_NAME} is Paper {PAPER_VERSION}")
    _guard(s)
    s = c.ensure_running(s["id"]) if running else c.ensure_stopped(s["id"])
    check(s["state"] == ("running" if running else "stopped"), f"{PAPER_NAME} is {s['state']}")
    return s


def _same_egg(t, expected):
    diff = [k for k in EGG_IDENTITY if t.get(k) != expected.get(k)]
    if [v["envName"] for v in t.get("variables", [])] != [v["envName"] for v in expected.get("variables", [])]:
        diff.append("variables")
    return diff


def _vanilla_template(c):
    egg = json.loads(EGG_FILE.read_text())
    preview = c.post("/templates/import/preview", {"egg": egg, "category": "Minecraft"})
    t = next((t for t in c.get("/templates") if t["key"] == "vanilla-minecraft"), None)
    if t is not None:
        diff = _same_egg(c.get(f"/templates/{t['id']}"), preview["template"] or {})
        check(not diff, f"existing template vanilla-minecraft {t['id']} is the Pterodactyl Vanilla egg (differs in: {diff or 'nothing'})")
        return t["id"]
    errors = [i for i in preview["issues"] if i["severity"] == "error"]
    check(preview["template"] is not None and not errors, f"egg preview has no errors ({len(preview['issues'])} notes)")
    check(preview["imagesNeedingAllowlist"] == [], "egg images need no allowlist change")
    r = c.post("/templates/import", {"egg": egg, "category": "Minecraft"})
    tid = (r.get("template") or r)["id"]
    check(bool(tid), f"imported Vanilla Minecraft egg as template {tid}")
    return tid


def ensure_vanilla(c, running=True):
    s = c.find_server(VANILLA_NAME)
    if s is None:
        tid = _vanilla_template(c)
        sid = _create(
            c,
            {
                "name": VANILLA_NAME,
                "slug": VANILLA_NAME,
                "description": "BlockForge e2e (scripts/e2e)",
                "templateId": tid,
                **_placement(c),
                "memoryLimitBytes": MEMORY,
                # Manual: the EULA is checked through the file manager before the first start.
                "startup": "manual",
                "restartPolicy": {"mode": "never"},
                "egg": {"variables": {"VANILLA_VERSION": VANILLA_VERSION}, "acceptEula": True},
            },
            VANILLA_NAME,
        )
        s = c.server(sid)
    else:
        print(f"  ..  reusing {VANILLA_NAME} {s['id']} ({s['state']})")
    sid = s["id"]
    check(s["templateName"] == "Vanilla Minecraft" and s["software"] is None, f"{VANILLA_NAME} runs the Vanilla Minecraft egg")
    jar = c.read_file(sid, "server.jar")
    check(jar is not None and jar["size"] > 1_000_000, "egg install script downloaded server.jar")
    eula = c.read_file(sid, "eula.txt")
    if eula is None or "eula=true" not in eula["content"]:
        c.write_file(sid, "eula.txt", "eula=true\n", base_sha256=eula["sha256"] if eula else None)
        print("  ..  wrote eula.txt through PUT /files/contents")
        eula = c.read_file(sid, "eula.txt")
    else:
        print("  ..  eula.txt already accepted (written by the control plane for acceptEula)")
    check(eula is not None and "eula=true" in eula["content"], "eula.txt says eula=true (file manager API)")
    _guard(c.server(sid))
    s = c.ensure_running(sid) if running else c.ensure_stopped(sid)
    check(s["state"] == ("running" if running else "stopped"), f"{VANILLA_NAME} is {s['state']}")
    return s


def check_ready(c, s):
    """The server printed its "Done (…)! For help, type" line (what the template's startupDone matches)."""
    lines = c.console_since(s["id"], -1)
    check(any(")! For help, type" in l for l in lines), f"{s['name']} console shows the Done line (ready)")


def run(c):
    print("setup_servers")
    p = ensure_paper(c)
    check_ready(c, p)
    v = ensure_vanilla(c)
    check_ready(c, v)
    print(f"  ..  {PAPER_NAME} {p['id']} {p['state']} {p['address']}")
    print(f"  ..  {VANILLA_NAME} {v['id']} {v['state']} {v['address']}")


if __name__ == "__main__":
    bf.main(run)
