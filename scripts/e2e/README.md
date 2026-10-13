# End-to-end scripts (live dev setup)

Stdlib-only Python 3 (3.9+) scripts that drive a running control plane through its public API
(`/api/v1`) against a real node. They are evidence runs, not unit tests: each prints one line per check
(`ok  …`), stops at the first failure (printing the API error body) and exits non-zero; `PASS` at the end.
After every run — passed, failed, or interrupted with Ctrl-C — the script's cleanup runs (`bf.main(run,
cleanup)`); a cleanup that cannot restore the node prints `CLEANUP FAILED …` and also exits non-zero.

## Prerequisites

- Control plane running at `BF_URL` (default `http://127.0.0.1:8080`) with Modrinth/Mojang reachable.
- Owner credentials: `BF_EMAIL` + `BF_PASSWORD`, or `BF_OWNER_FILE`, or the gitignored `.data/dev-owner.txt`
  of this checkout or of the main checkout (git worktrees use the main checkout's file; nothing outside the
  repository is searched). The file must not be readable by group/others (`chmod 600`). Secrets are never printed.
- An online node named `BF_NODE` (default `test-node`) with free allocations outside the forbidden ports and
  ~3 GiB allocatable memory, running an agent with the `fs.hash` / `jar.readEntries` capabilities.
- Internet access from the node (Paper download, egg install script, Modrinth CDN, Mojang profile lookups)
  and from this machine (`e2e_ext_updates.py` downloads one older Chunky jar from the Modrinth CDN, in memory).

## Port guard

`bf.FORBIDDEN_PORTS` = 25565, 25570, 25571 (ATM11 and two untracked old servers on the test node). New e2e
servers get an explicit allocation (the lowest free one outside that set); every start/restart through
`bf.Client.action` — and `setup_servers.py` before it starts or stops a reused server — refuses a server with
an allocation on a forbidden port (fail closed, nothing is started).

## Scripts

Run from the repository root, e.g. `python3 scripts/e2e/setup_servers.py`.

| Script | Covers | Leaves |
| --- | --- | --- |
| `bf.py` | Client: login, CSRF, idempotency keys, jobs, server state/actions, console, file API, port guard, `check()`, `main(run, cleanup)`. | — |
| `setup_servers.py` | Creates or reuses `e2e-paper` (built-in template, Paper 26.3, 1.5 GiB) and `e2e-vanilla` (Pterodactyl Vanilla Minecraft egg — imported from `packages/eggs/test/fixtures` if no `vanilla-minecraft` template exists, an existing one is compared with the fixture first; VANILLA_VERSION 26.3, 1.5 GiB; `eula.txt` checked/written through the file API); starts both and checks the Done line. The other scripts call into it. | both servers **running** |
| `e2e_players.py` | Running Paper: overview (`list uuids`, list files, `server.properties`), Mojang lookup `Notch`, whitelist-add, op, ban (reason), ban-ip, pardon, pardon-ip, deop, whitelist-remove — each confirmed by the server's feedback and by re-reading the lists; kick of an offline player → `ok:false` "No player was found"; `expiresAt` / op level while running → 409 `requires_stopped`; `op @a`, IPv6 ban, unknown field → 400. | `e2e-paper` running (started if needed); Notch / 203.0.113.7 on no list |
| `e2e_players_stopped.py` | Stopped Vanilla egg: whitelist-add, op (level 2, bypass), timed ban (2100-01-01), ban-ip as file edits; the four JSON files read back through the file API in the server's Gson format; kick / whitelist-reload → 409 `not_running`; start → `whitelist list`, `banlist players`, `banlist ips`, `op` confirm the server loaded every entry; cleanup through the console path. | `e2e-vanilla` **stopped** (stopped first if it was running); Notch / 203.0.113.8 on no list |
| `e2e_extensions.py` | Running Paper: full scan; Modrinth search `chunky`; project (releases only) + plan; install job (SHA-512-verified fetch + rescan) → source `modrinth`, metadata, loadable; disable (`.jar.disabled`) / enable; upload of a generated metadata-only plugin jar (transfer PUT + complete); remove → keep area → history → rollback job; restart → Paper console `[Chunky] Enabling Chunky`. | `e2e-paper` running (restarted once); no `Chunky*` / `BfE2E*` jar in `plugins/` |
| `e2e_ext_updates.py` | Running Paper: `GET …/extensions/updates`; project route releases-only by default and prereleases with `allowPrerelease=true` (`viaversion`, which publishes betas for 26.3 — swap the project if that stops being true); an older Chunky (`OLD_VERSION`, 1.4.40) copied in through the file manager → identified on Modrinth by SHA-512 on the next incremental scan and offered an update; then the same version installed via the install route (pinned, `allowIncompatibleVersion`) and updated via `POST …/extensions/updates/apply` to Modrinth's current Chunky release (SHA-512, history `update`). | `e2e-paper` running; no `Chunky*` jar in `plugins/` |

## Cleanup scope

Cleanup only touches the two e2e servers and only the state the scripts create: the Notch whitelist/op/ban
entries and the IP bans 203.0.113.7 / 203.0.113.8 (console commands on a running server — a 504 `no_feedback`
is retried once — or file edits on a stopped one; if a running server still lists an entry, it is stopped,
the entry removed as a file edit, and the server left stopped), and every `Chunky*` / `BfE2E*` extension in `e2e-paper`'s `plugins/`
(removed into the keep area, so the history keeps a rollback for a while). `e2e_players_stopped.py` also stops
`e2e-vanilla` again when it started it. Removed jars, the imported `vanilla-minecraft` template, the two servers
and Chunky's own `plugins/Chunky/` config folder are kept. Delete the servers through the UI/API
(`DELETE /servers/:id?deleteData=true`) when no longer needed. At most two e2e servers run at once.

## Known environment quirk

The server's first Mojang profile lookup after a start can take ~10 s, longer than the 5 s feedback window
of console-backed player actions; the API then answers 504 `no_feedback` (command sent, outcome unknown).
`e2e_players.py` retries once and requires the retry's own feedback: either the normal confirmation, or a
no-op refusal ("already …") together with re-read lists showing that the first command applied.
