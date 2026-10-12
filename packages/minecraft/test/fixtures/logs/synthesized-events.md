# Synthesized log lines

These lines are **not** captured from running servers (that would require accepting the
Minecraft EULA and connecting a real client). Each one is built from a format string verified in
the official artifacts on 2026-10-12, wrapped in the log4j layout observed in real output:

| Event | Format source |
|---|---|
| `%s joined the game`, `%s left the game`, `%s (formerly known as %s) joined the game` | `assets/minecraft/lang/en_us.json` in the 26.3 server jar (`multiplayer.player.joined`, `.left`, `.joined.renamed`) |
| `{}[{}] logged in with entity id {} at ({}, {}, {})` | string constant in 26.3 `PlayerList.class` |
| `{} lost connection: {}` | string constant in 26.3 packet listener classes |
| `Done ({})! For help, type "help"` | string constant in 26.3 `DedicatedServer.class` |
| `[connected player] NAME (ADDR) has connected/disconnected`, `[server connection] NAME -> SERVER has connected` | Velocity 4.2.0 `ConnectedPlayer#toString`, `VelocityServerConnection#toString`, `MinecraftConnection`, `AuthSessionHandler` |
| `TPS from last 1m, 5m, 15m: ` | Paper `TicksPerSecondCommand.java` (main branch) |
| Velocity `Done (1.55s)!` | **real** (velocity-4.2.0-startup.log) |

Layouts: vanilla/Fabric `[HH:mm:ss] [thread/LEVEL]: msg`, Paper console `[HH:mm:ss LEVEL]: msg`,
Forge console `[HH:mm:ss] [thread/LEVEL] [logger]: msg` — all observed in the real `*-first-start.log` files.
