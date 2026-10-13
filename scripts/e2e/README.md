# End-to-end scripts (live dev setup)

Stdlib-only Python 3 (3.9+) scripts that drive a running control plane through its public API
(`/api/v1`) against a real node. They are evidence runs, not unit tests: each prints one line per check
(`ok  …`), stops at the first failure (printing the API error body) and exits non-zero; `PASS` at the end.

## Prerequisites

- Control plane running at `BF_URL` (default `http://127.0.0.1:8080`) with Modrinth/Mojang reachable.
- Owner credentials: `BF_EMAIL` + `BF_PASSWORD`, or `BF_OWNER_FILE`, or the gitignored
  `.data/dev-owner.txt` of this checkout or a parent directory (git worktrees find the main checkout's file).
  Secrets are never printed.
- An online node named `BF_NODE` (default `test-node`) with a free allocation in its pool and ~3 GiB
  allocatable memory, running an agent with the `fs.hash` / `jar.readEntries` capabilities.
- Internet access from the node (Paper download, egg install script, Modrinth CDN, Mojang profile lookups)
  and from this machine (`e2e_ext_updates.py` downloads one Chunky jar from the Modrinth CDN).

## Scripts

Run from the repository root, e.g. `python3 scripts/e2e/setup_servers.py`.

| Script | Covers |
| --- | --- |
| `bf.py` | Client: login, CSRF, idempotency keys, jobs, server state/actions, console, file API, `check()`, `main()`. |
| `setup_servers.py` | Creates or reuses `e2e-paper` (built-in template, Paper 26.3, 1.5 GiB) and `e2e-vanilla` (Pterodactyl Vanilla Minecraft egg, imported from `packages/eggs/test/fixtures` if no `vanilla-minecraft` template exists; VANILLA_VERSION 26.3, 1.5 GiB; `eula.txt` checked/written through the file API); starts both and checks the Done line. The other scripts call into it. |
| `e2e_players.py` | Running Paper: overview (`list uuids`, list files, `server.properties`), Mojang lookup `Notch`, whitelist-add, op, ban (reason), ban-ip, pardon, pardon-ip, deop, whitelist-remove — each confirmed by the server's feedback and by re-reading the lists; kick of an offline player → `ok:false` "No player was found"; `expiresAt` / op level while running → 409 `requires_stopped`; `op @a`, IPv6 ban, unknown field → 400. |
| `e2e_players_stopped.py` | Stopped Vanilla egg: whitelist-add, op (level 2, bypass), timed ban (2100-01-01), ban-ip as file edits; the four JSON files read back through the file API in the server's Gson format; kick / whitelist-reload → 409 `not_running`; start → `whitelist list`, `banlist players`, `banlist ips`, `op` confirm the server loaded every entry; cleanup through the console path; stops the server again. |
| `e2e_extensions.py` | Running Paper: full scan; Modrinth search `chunky`; project (releases only) + plan; install job (SHA-512-verified fetch + rescan) → source `modrinth`, metadata, loadable; disable (`.jar.disabled`) / enable; upload of a generated metadata-only plugin jar (transfer PUT + complete); remove → keep area → history → rollback job; restart → Paper console `[Chunky] Enabling Chunky`; cleanup. |
| `e2e_ext_updates.py` | Running Paper: `GET …/extensions/updates`; project route releases-only by default (`luckperms`); Chunky 1.4.40 copied in through the file manager → identified on Modrinth by SHA-512 on the next incremental scan and offered an update; then Chunky 1.4.40 installed via the install route (pinned version, `allowIncompatibleVersion`), update applied via `POST …/extensions/updates/apply` → 1.5.3 replaces it (SHA-512, history `update`); cleanup. |

## State

The scripts are idempotent: servers are found by name and reused; every player-list entry and extension
they add is removed again (also after an interrupted earlier run). Afterwards `e2e-paper` is running and
`e2e-vanilla` stopped. Only these two servers are touched; at most two run at once. Delete them through the
UI/API (`DELETE /servers/:id?deleteData=true`) when no longer needed.

## Known environment quirk

The server's first Mojang profile lookup after a start can take ~10 s, longer than the 5 s feedback window
of console-backed player actions; the API then answers 504 `no_feedback` (command sent, outcome unknown).
`e2e_players.py` notes this and retries once.
