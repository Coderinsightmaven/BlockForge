"""Players on a running Paper 26.3 server (`e2e-paper`): overview, Mojang lookup and every console-backed
moderation action, each confirmed by the server's own feedback and by re-reading the lists.

    python3 scripts/e2e/e2e_players.py

Leaves Notch / 203.0.113.7 off every list (also cleans up after an interrupted earlier run).
"""

import time

import bf
from bf import check
from setup_servers import ensure_paper

PLAYER = "Notch"
NOTCH_UUID = "069a79f4-44e9-4726-a5be-fca90e38aaf5"
IP = "203.0.113.7"
REASON = "BlockForge e2e"


def overview(c, sid):
    return c.get(f"/servers/{sid}/players")


def act(c, sid, body):
    return c.post(f"/servers/{sid}/players/actions", body)


def in_lists(ov):
    return {
        "whitelist": any(e["name"] == PLAYER for e in ov["whitelist"]["entries"]),
        "ops": any(e["name"] == PLAYER for e in ov["ops"]),
        "bannedPlayers": any(e["name"] == PLAYER for e in ov["bannedPlayers"]),
        "bannedIps": any(e["ip"] == IP for e in ov["bannedIps"]),
    }


def wait_lists(c, sid, key, present, timeout=10.0):
    """Re-reads the overview until `key` has (or lacks) our entry; the server saves its lists right after the command."""
    deadline = time.time() + timeout
    while True:
        ov = overview(c, sid)
        if in_lists(ov)[key] == present:
            return ov
        if time.time() > deadline:
            raise AssertionError(f"{key} {'still lacks' if present else 'still has'} the e2e entry after {timeout}s")
        time.sleep(0.5)


def console_action(c, sid, body, expect_words, key=None, present=None):
    try:
        r = act(c, sid, body)
    except bf.ApiError as e:
        # The server's first Mojang profile lookup after a start can take ~10 s (> the 5 s feedback window),
        # which the contract reports as 504 no_feedback (sent, outcome unknown). Note it and retry once.
        err = e.body.get("error", {}) if isinstance(e.body, dict) else {}
        if e.status != 504 or (err.get("details") or {}).get("reason") != "no_feedback":
            raise
        print(f"  ..  note: {body['action']} -> 504 no_feedback (sent, outcome unknown); retrying once")
        time.sleep(5)
        if key is not None and in_lists(overview(c, sid))[key] == present:
            # The first command took effect late; the retry must report it as a no-op, so only check the lists.
            check(True, f"{body['action']}: applied by the first (late) command, lists show it")
            return None
        r = act(c, sid, body)
    fb = r["feedback"]
    check(r["applied"] == "console" and fb is not None and fb["ok"], f"{body['action']}: applied via console, feedback ok")
    msg = fb["message"]
    check(all(w.lower() in msg.lower() for w in expect_words), f"{body['action']}: server said {msg!r}")
    if key is not None:
        wait_lists(c, sid, key, present)
        check(True, f"{body['action']}: re-read {key} {'contains' if present else 'no longer contains'} the entry")
    return r


def cleanup(c, sid):
    ov = overview(c, sid)
    present = in_lists(ov)
    steps = [("bannedPlayers", {"action": "pardon", "name": PLAYER}), ("bannedIps", {"action": "pardon-ip", "ip": IP}),
             ("ops", {"action": "deop", "name": PLAYER}), ("whitelist", {"action": "whitelist-remove", "name": PLAYER})]
    for key, body in steps:
        if present[key]:
            act(c, sid, body)
            wait_lists(c, sid, key, False)
            print(f"  ..  cleanup: {body['action']}")


def run(c):
    print("e2e_players (running Paper)")
    s = ensure_paper(c, running=True)
    sid = s["id"]
    cleanup(c, sid)

    ov = overview(c, sid)
    check(ov["online"]["source"] == "list" and ov["online"]["count"] is not None, f"overview: online from `list uuids` ({ov['online']['count']}/{ov['online']['max']})")
    check(ov["onlineMode"] is not None and ov["whitelist"]["enabled"] is not None, f"overview: server.properties read (online-mode {ov['onlineMode']}, whitelist {ov['whitelist']['enabled']})")
    check(ov["listErrors"] == [], "overview: list files read without errors")
    for a in ("kick", "ban", "pardon", "ban-ip", "pardon-ip", "op", "deop", "whitelist-add", "whitelist-remove"):
        check(a in ov["availableActions"], f"overview: action {a} available")
    check(not any(in_lists(ov).values()), "overview: e2e entries absent before the run")

    lk = c.get(f"/servers/{sid}/players/lookup?name=Notch")
    check(lk["uuid"] == NOTCH_UUID and lk["source"] == "mojang" and lk["name"] == "Notch", f"lookup Notch -> {lk['uuid']} ({lk['source']})")

    console_action(c, sid, {"action": "whitelist-add", "name": PLAYER}, ["Added", PLAYER, "whitelist"], "whitelist", True)
    ov = overview(c, sid)
    wl = next(e for e in ov["whitelist"]["entries"] if e["name"] == PLAYER)
    check(wl["uuid"] == NOTCH_UUID, "whitelist entry has Notch's Mojang UUID")
    console_action(c, sid, {"action": "op", "name": PLAYER}, ["Made", PLAYER, "operator"], "ops", True)
    console_action(c, sid, {"action": "ban", "name": PLAYER, "reason": REASON}, ["Banned", PLAYER, REASON], "bannedPlayers", True)
    ban = next(e for e in overview(c, sid)["bannedPlayers"] if e["name"] == PLAYER)
    check(ban["reason"] == REASON and ban["expiresAt"] is None and ban["active"], f"ban entry: reason {ban['reason']!r}, permanent, active, source {ban['source']!r}")
    console_action(c, sid, {"action": "ban-ip", "ip": IP, "reason": REASON}, ["Banned", IP], "bannedIps", True)
    console_action(c, sid, {"action": "pardon", "name": PLAYER}, ["Unbanned", PLAYER], "bannedPlayers", False)
    console_action(c, sid, {"action": "pardon-ip", "ip": IP}, ["Unbanned", IP], "bannedIps", False)
    console_action(c, sid, {"action": "deop", "name": PLAYER}, [PLAYER, "no longer", "operator"], "ops", False)
    console_action(c, sid, {"action": "whitelist-remove", "name": PLAYER}, ["Removed", PLAYER, "whitelist"], "whitelist", False)

    r = act(c, sid, {"action": "kick", "name": PLAYER})
    fb = r["feedback"]
    check(r["applied"] == "console" and fb is not None and fb["ok"] is False and "no player was found" in fb["message"].lower(),
          f"kick offline player -> ok:false {fb and fb['message']!r}")

    err = c.expect_error(lambda: act(c, sid, {"action": "ban", "name": PLAYER, "expiresAt": 4102444800000}), 409, "INVALID_STATE")
    check((err.get("details") or {}).get("reason") == "requires_stopped", "ban with expiresAt while running -> 409 requires_stopped")
    err = c.expect_error(lambda: act(c, sid, {"action": "op", "name": PLAYER, "level": 2}), 409, "INVALID_STATE")
    check((err.get("details") or {}).get("reason") == "requires_stopped", "op with level while running -> 409 requires_stopped")
    c.expect_error(lambda: act(c, sid, {"action": "op", "name": "@a"}), 400, "VALIDATION_FAILED")
    check(True, "op @a -> 400 VALIDATION_FAILED")
    c.expect_error(lambda: act(c, sid, {"action": "ban-ip", "ip": "2001:db8::1"}), 400, "VALIDATION_FAILED")
    check(True, "ban-ip with an IPv6 address -> 400")
    c.expect_error(lambda: act(c, sid, {"action": "ban", "name": PLAYER, "expiresIn": 5}), 400, "VALIDATION_FAILED")
    check(True, "unknown field (strict body) -> 400")

    ov = overview(c, sid)
    check(not any(in_lists(ov).values()), "final lists: no e2e entries left")


if __name__ == "__main__":
    bf.main(run)
