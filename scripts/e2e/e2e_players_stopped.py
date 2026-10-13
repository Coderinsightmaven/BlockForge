"""Players on a stopped server (`e2e-vanilla`, Pterodactyl Vanilla Minecraft egg): moderation actions applied
as atomic edits of the list files, verified through the file API (Gson format), then loaded by the server
after a start; cleanup through the console path.

    python3 scripts/e2e/e2e_players_stopped.py

Always (also after a failure, a 504 or Ctrl-C) removes Notch / 203.0.113.8 from every list again (console,
or file edits after stopping) and stops e2e-vanilla if this run started it. Leaves e2e-vanilla stopped
(memory on the test node is tight).
"""

import json
import re

import bf
from bf import check
from e2e_players import console_action, in_lists, remove_entries
from setup_servers import VANILLA_NAME, ensure_vanilla

PLAYER = "Notch"
NOTCH_UUID = "069a79f4-44e9-4726-a5be-fca90e38aaf5"
IP = "203.0.113.8"
REASON = "BlockForge e2e stopped"
EXPIRES_MS = 4102444800000  # 2100-01-01T00:00:00Z
GSON_DATE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}$")
STATE = {"started": False}


def overview(c, sid):
    return c.get(f"/servers/{sid}/players")


def act(c, sid, body):
    return c.post(f"/servers/{sid}/players/actions", body)


def present(ov):
    return in_lists(ov, IP)


def file_action(c, sid, body, key):
    r = act(c, sid, body)
    check(r["applied"] == "file" and r["feedback"] is None and r["overview"] is not None, f"{body['action']}: applied as a file edit")
    check(present(r["overview"])[key], f"{body['action']}: returned overview lists the entry in {key}")
    return r["overview"]


def read_json(c, sid, path):
    f = c.read_file(sid, path)
    check(f is not None and not f["truncated"], f"read {path} through the file API")
    return json.loads(f["content"])


def run(c):
    print("e2e_players_stopped (stopped Vanilla egg)")
    s = ensure_vanilla(c, running=False)
    sid = s["id"]
    remove_entries(c, sid, IP)
    check(not any(present(overview(c, sid)).values()), "e2e entries absent before the run")

    ov = overview(c, sid)
    check(ov["online"]["count"] is None and ov["online"]["source"] != "list", f"overview of a stopped server: online count unknown (source {ov['online']['source']})")
    check("kick" not in ov["availableActions"], "kick not offered while stopped")

    file_action(c, sid, {"action": "whitelist-add", "name": PLAYER}, "whitelist")
    ov = file_action(c, sid, {"action": "op", "name": PLAYER, "level": 2, "bypassesPlayerLimit": True}, "ops")
    op = next(e for e in ov["ops"] if e["name"] == PLAYER)
    check(op["level"] == 2 and op["bypassesPlayerLimit"] is True and op["uuid"] == NOTCH_UUID, "op entry: level 2, bypass, Mojang UUID")
    ov = file_action(c, sid, {"action": "ban", "name": PLAYER, "reason": REASON, "expiresAt": EXPIRES_MS}, "bannedPlayers")
    ban = next(e for e in ov["bannedPlayers"] if e["name"] == PLAYER)
    check(ban["expiresAt"] == EXPIRES_MS and ban["reason"] == REASON and ban["active"], "ban entry: expires 2100-01-01, reason, active")
    check(ban["source"].startswith("BlockForge ("), f"ban source {ban['source']!r}")
    file_action(c, sid, {"action": "ban-ip", "ip": IP, "reason": REASON}, "bannedIps")

    # Files on disk, in the server's own (Gson) format.
    bans = read_json(c, sid, "banned-players.json")
    b = next(e for e in bans if e.get("name") == PLAYER)
    check(set(b) == {"uuid", "name", "created", "source", "expires", "reason"}, f"banned-players.json entry keys {sorted(b)}")
    check(b["uuid"] == NOTCH_UUID and GSON_DATE.match(b["created"]) is not None, f"banned-players.json created {b['created']!r}")
    check(b["expires"] == "2100-01-01 00:00:00 +0000", f"banned-players.json expires {b['expires']!r}")
    check(b["reason"] == REASON and b["source"].startswith("BlockForge ("), "banned-players.json reason + source")
    ips = read_json(c, sid, "banned-ips.json")
    i = next(e for e in ips if e.get("ip") == IP)
    check(set(i) == {"ip", "created", "source", "expires", "reason"} and i["expires"] == "forever", f"banned-ips.json entry {sorted(i)} expires {i['expires']!r}")
    ops = read_json(c, sid, "ops.json")
    o = next(e for e in ops if e.get("name") == PLAYER)
    check(o == {"uuid": NOTCH_UUID, "name": PLAYER, "level": 2, "bypassesPlayerLimit": True}, "ops.json entry {uuid, name, level 2, bypassesPlayerLimit true}")
    wl = read_json(c, sid, "whitelist.json")
    check({"uuid": NOTCH_UUID, "name": PLAYER} in wl, "whitelist.json entry {uuid, name}")

    err = c.expect_error(lambda: act(c, sid, {"action": "kick", "name": PLAYER}), 409, "INVALID_STATE")
    check((err.get("details") or {}).get("reason") == "not_running", "kick while stopped -> 409 not_running")
    err = c.expect_error(lambda: act(c, sid, {"action": "whitelist-reload"}), 409, "INVALID_STATE")
    check((err.get("details") or {}).get("reason") == "not_running", "whitelist-reload while stopped -> 409 not_running")

    # Start: the server must load every entry.
    STATE["started"] = True
    s = c.ensure_running(sid)
    check(s["state"] == "running", "started e2e-vanilla")
    line = c.console(sid, "whitelist list", expect="whitelisted player")
    check(PLAYER in line, f"server loaded the whitelist: {line.split(']: ')[-1]!r}")
    line = c.console(sid, "banlist players", expect=f"{PLAYER} was banned by")
    check(REASON in line, f"server loaded the timed ban: {line.split(']: ')[-1]!r}")
    line = c.console(sid, "banlist ips", expect=f"{IP} was banned by")
    check(REASON in line, f"server loaded the IP ban: {line.split(']: ')[-1]!r}")
    line = c.console(sid, f"op {PLAYER}", expect=lambda l: "Nothing changed" in l or "Made " in l)
    check("Nothing changed" in line, f"server loaded the op entry: {line.split(']: ')[-1]!r}")
    o = next(e for e in read_json(c, sid, "ops.json") if e.get("name") == PLAYER)
    check(o["level"] == 2 and o["bypassesPlayerLimit"] is True, "ops.json after start still level 2 + bypass")
    ov = overview(c, sid)
    check(all(present(ov).values()), "running overview lists all four entries")
    ban = next(e for e in ov["bannedPlayers"] if e["name"] == PLAYER)
    check(ban["expiresAt"] == EXPIRES_MS, "running overview: ban still expires 2100-01-01")

    # Cleanup through the console (running server -> console path), each confirmed by feedback + lists.
    console_action(c, sid, {"action": "pardon", "name": PLAYER}, ["Unbanned", PLAYER], "bannedPlayers", False, ip=IP)
    console_action(c, sid, {"action": "pardon-ip", "ip": IP}, ["Unbanned IP", IP], "bannedIps", False, ip=IP)
    console_action(c, sid, {"action": "deop", "name": PLAYER}, ["no longer", "operator"], "ops", False, ip=IP)
    console_action(c, sid, {"action": "whitelist-remove", "name": PLAYER}, ["Removed", PLAYER], "whitelist", False, ip=IP)
    check(not any(present(overview(c, sid)).values()), "final lists: no e2e entries left")
    s = c.ensure_stopped(sid)
    STATE["started"] = False
    check(s["state"] == "stopped", "stopped e2e-vanilla again")


def cleanup(c):
    """Runs after every run (bf.main): removes leftover e2e entries, stops e2e-vanilla if this run started it."""
    s = c.find_server(VANILLA_NAME)
    if s is None:
        return
    sid = s["id"]
    c.wait_state(sid, ("running", "stopped", "crashed"), timeout=180)
    try:
        remove_entries(c, sid, IP, stop_fallback=True)
    finally:
        if STATE["started"] and c.server(sid)["state"] != "stopped":
            c.ensure_stopped(sid)
            print("  ..  cleanup: stopped e2e-vanilla (started by this run)")


if __name__ == "__main__":
    bf.main(run, cleanup)
