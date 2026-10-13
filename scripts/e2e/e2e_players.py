"""Players on a running Paper 26.3 server (`e2e-paper`): overview, Mojang lookup and every console-backed
moderation action, each confirmed by the server's own feedback and by re-reading the lists.

    python3 scripts/e2e/e2e_players.py

Always (also after a failure, a 504 or Ctrl-C) removes Notch / 203.0.113.7 from every list again; it also
cleans up after an interrupted earlier run. Leaves e2e-paper running.
"""

import time

import bf
from bf import check
from setup_servers import PAPER_NAME, ensure_paper

PLAYER = "Notch"
NOTCH_UUID = "069a79f4-44e9-4726-a5be-fca90e38aaf5"
IP = "203.0.113.7"
REASON = "BlockForge e2e"
LIST_KEYS = ("whitelist", "ops", "bannedPlayers", "bannedIps")
# After a 504 no_feedback: the control plane's command linger (60 s, players/console.ts) plus a margin.
LATE_FEEDBACK_S = 65.0


def overview(c, sid):
    return c.get(f"/servers/{sid}/players")


def act(c, sid, body):
    return c.post(f"/servers/{sid}/players/actions", body)


def in_lists(ov, ip):
    return {
        "whitelist": any(e["name"] == PLAYER for e in ov["whitelist"]["entries"]),
        "ops": any(e["name"] == PLAYER for e in ov["ops"]),
        "bannedPlayers": any(e["name"] == PLAYER for e in ov["bannedPlayers"]),
        "bannedIps": any(e["ip"] == ip for e in ov["bannedIps"]),
    }


def wait_lists(c, sid, ip, key, present, timeout=10.0):
    """Re-reads the overview until `key` has (or lacks) the e2e entry (the server saves right after a command).
    Returns the overview, or None on timeout."""
    deadline = time.time() + timeout
    while True:
        ov = overview(c, sid)
        if in_lists(ov, ip)[key] == present:
            return ov
        if time.time() > deadline:
            return None
        time.sleep(0.5)


def remove_entries(c, sid, ip, stop_fallback=False):
    """Removes Notch / `ip` from every list; idempotent and tolerant of 504 no_feedback.

    Running (or degraded) server: console commands. A 504 no_feedback is never resent — the control plane keeps
    the timed-out command lingering for up to 60 s, so a resend would be ambiguous — instead the lists are
    re-read for up to LATE_FEEDBACK_S. Stopped server: file edits. With `stop_fallback`, entries a live server
    did not remove are removed as file edits after stopping it (left stopped). Raises AssertionError naming
    what is left.
    """
    undo = {
        "bannedPlayers": {"action": "pardon", "name": PLAYER},
        "bannedIps": {"action": "pardon-ip", "ip": ip},
        "ops": {"action": "deop", "name": PLAYER},
        "whitelist": {"action": "whitelist-remove", "name": PLAYER},
    }

    def attempt():
        left = []
        for key in ("bannedPlayers", "bannedIps", "ops", "whitelist"):
            if not in_lists(overview(c, sid), ip)[key]:
                continue
            body = undo[key]
            wait = 10.0
            try:
                r = act(c, sid, body)
                print(f"  ..  cleanup: {body['action']} ({r['applied']}{', ' + repr(r['feedback']['message']) if r['feedback'] else ''})")
            except bf.ApiError as e:
                print(f"  ..  cleanup: {body['action']} -> HTTP {e.status} {(e.body.get('error') or {}).get('code') if isinstance(e.body, dict) else ''}")
                if bf.is_no_feedback(e):
                    wait = LATE_FEEDBACK_S
            if wait_lists(c, sid, ip, key, False, timeout=wait) is None:
                left.append(key)
        return left

    left = attempt()
    if left and stop_fallback and c.server(sid)["state"] != "stopped":
        print(f"  ..  cleanup: {left} still listed; stopping the server to remove them as file edits")
        c.ensure_stopped(sid)
        left = attempt()
    if left:
        raise AssertionError(f"cleanup could not remove the e2e entries from {left} on server {sid}")


def console_action(c, sid, body, expect_words, key, present, ip=IP):
    """One console-backed action: feedback ok + expected wording, then the re-read list must reflect it.

    A 504 no_feedback (the server's first Mojang lookup after a start can exceed the 5 s window) is NOT
    resent: the control plane keeps the timed-out command lingering for 60 s, so a resend would be ambiguous.
    The lists are re-read for up to LATE_FEEDBACK_S instead; if they show the action applied, the step is
    recorded as "504 no_feedback, applied (lists confirm)" — distinct from a feedback-confirmed step — else
    it fails. Returns the action result, or None after such a 504.
    """
    try:
        r = act(c, sid, body)
    except bf.ApiError as e:
        if not bf.is_no_feedback(e):
            raise
        print(f"  ..  note: {body['action']} -> 504 no_feedback (sent, outcome unknown); not resending, re-reading {key} for up to {LATE_FEEDBACK_S:.0f} s")
        t0 = time.time()
        confirmed = wait_lists(c, sid, ip, key, present, timeout=LATE_FEEDBACK_S) is not None
        check(confirmed, f"{body['action']}: 504 no_feedback, applied (lists confirm, after {time.time() - t0:.1f} s; no server feedback)")
        return None
    fb = r["feedback"]
    check(r["applied"] == "console" and fb is not None and fb["ok"], f"{body['action']}: applied via console, feedback ok")
    msg = fb["message"]
    check(all(w.lower() in msg.lower() for w in expect_words), f"{body['action']}: server said {msg!r}")
    check(wait_lists(c, sid, ip, key, present) is not None, f"{body['action']}: re-read {key} {'contains' if present else 'no longer contains'} the entry")
    return r


def run(c):
    print("e2e_players (running Paper)")
    s = ensure_paper(c, running=True)
    sid = s["id"]
    remove_entries(c, sid, IP)

    ov = overview(c, sid)
    check(ov["online"]["source"] == "list" and ov["online"]["count"] is not None, f"overview: online from `list uuids` ({ov['online']['count']}/{ov['online']['max']})")
    check(ov["onlineMode"] is not None and ov["whitelist"]["enabled"] is not None, f"overview: server.properties read (online-mode {ov['onlineMode']}, whitelist {ov['whitelist']['enabled']})")
    check(ov["listErrors"] == [], "overview: list files read without errors")
    for a in ("kick", "ban", "pardon", "ban-ip", "pardon-ip", "op", "deop", "whitelist-add", "whitelist-remove"):
        check(a in ov["availableActions"], f"overview: action {a} available")
    check(not any(in_lists(ov, IP).values()), "overview: e2e entries absent before the run")

    lk = c.get(f"/servers/{sid}/players/lookup?name=Notch")
    check(lk["uuid"] == NOTCH_UUID and lk["source"] == "mojang" and lk["name"] == "Notch", f"lookup Notch -> {lk['uuid']} ({lk['source']})")

    console_action(c, sid, {"action": "whitelist-add", "name": PLAYER}, ["Added", PLAYER, "whitelist"], "whitelist", True)
    wl = next(e for e in overview(c, sid)["whitelist"]["entries"] if e["name"] == PLAYER)
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

    check(not any(in_lists(overview(c, sid), IP).values()), "final lists: no e2e entries left")


def cleanup(c):
    """Runs after every run (bf.main): removes the e2e entries if a failure left any behind."""
    s = c.find_server(PAPER_NAME)
    if s is not None:
        c.wait_state(s["id"], bf.SETTLED_STATES, timeout=180)  # running/degraded: console path; stopped/crashed: files
        remove_entries(c, s["id"], IP, stop_fallback=True)


if __name__ == "__main__":
    bf.main(run, cleanup)
