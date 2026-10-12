# Velocity package fixtures

| File | Origin |
|---|---|
| `default-velocity-4.2.0.toml` | **Real.** `default-velocity.toml` extracted from `velocity-4.2.0-30.jar` (Fill API build 30, sha256 `35a5596a…aa8`, captured 2026-10-11); byte-identical to `proxy/src/main/resources/default-velocity.toml` at the 4.2.0 release commit `c10b4925` and to the `velocity.toml` Velocity wrote on first start in a container. |
| `paper-global.representative.yml`, `spigot.representative.yml` | **Representative, not server-generated.** Paper/Spigot only write these files after the Minecraft EULA has been accepted, which BlockForge did not do for fixture capture. Key paths and defaults follow PaperMC's docs config specs (`github.com/PaperMC/docs` `src/config/paper/{paper-global,spigot}.yml` @ `3d540521`, 2026-09-29); layout mimics SnakeYAML/Configurate output (2-space indent, block sequences at the parent indentation, `secret: ''`). |

`.gitattributes` marks fixtures `-text` so line endings are never rewritten (byte-for-byte tests).
