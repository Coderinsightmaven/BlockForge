import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { templates } from "../db/schema/index.js";

export const MINECRAFT_TEMPLATE_KEY = "minecraft-java";
export const VELOCITY_TEMPLATE_KEY = "velocity";

type TemplateInsert = typeof templates.$inferInsert;

/**
 * Built-in catalogue-driven templates. Their behaviour (images per Java major, launch command,
 * readiness parsing) lives in code; the rows exist so servers can reference them and admins can
 * rename/re-describe/re-categorise them.
 */
export const BUILTIN_TEMPLATES: Omit<TemplateInsert, "id">[] = [
  {
    key: MINECRAFT_TEMPLATE_KEY,
    name: "Minecraft: Java Edition",
    description: "Vanilla, Paper, Purpur, Folia, Fabric, Forge and NeoForge servers with versions and builds from the official catalogues.",
    category: "Minecraft",
    kind: "minecraft",
    game: "minecraft-java",
    author: "BlockForge",
    source: "builtin",
    sourceFormat: null,
    dockerImages: [],
    startup: "",
    configFiles: [],
    startupDone: [],
    stop: { type: "command", command: "stop" },
    install: null,
    features: ["eula", "java_version"],
    fileDenylist: [],
    runtime: { dataMountPath: "/data", readOnlyRootfs: true },
  },
  {
    key: VELOCITY_TEMPLATE_KEY,
    name: "Velocity proxy",
    description: "Velocity proxy for Minecraft networks (builds from PaperMC).",
    category: "Minecraft",
    kind: "velocity",
    game: "minecraft-proxy",
    author: "BlockForge",
    source: "builtin",
    sourceFormat: null,
    dockerImages: [],
    startup: "",
    configFiles: [],
    startupDone: [],
    stop: { type: "command", command: "end" },
    install: null,
    features: [],
    fileDenylist: [],
    runtime: { dataMountPath: "/data", readOnlyRootfs: true },
  },
];

/**
 * Idempotent: inserts missing built-ins and re-asserts their code-defined fields on upgrade, while
 * keeping the admin-editable ones (name, description, category).
 */
export async function seedBuiltinTemplates(db: Db): Promise<void> {
  for (const t of BUILTIN_TEMPLATES) {
    await db
      .insert(templates)
      .values({ id: randomUUID(), ...t })
      .onConflictDoUpdate({
        target: templates.key,
        set: {
          kind: t.kind,
          game: t.game,
          source: "builtin",
          sourceFormat: null,
          dockerImages: t.dockerImages,
          startup: t.startup,
          configFiles: t.configFiles,
          startupDone: t.startupDone,
          stop: t.stop,
          install: null,
          features: t.features,
          runtime: t.runtime,
          updatedAt: sql`now()`,
        },
      });
  }
}
