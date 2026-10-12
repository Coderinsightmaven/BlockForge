import { Template, TemplateGame, TemplateKind, type ConfigFileRule, type InstallScript, type StopConfig } from "@blockforge/contracts";
import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { enumCheck, nullableEnumCheck, tsz } from "./_helpers.js";

export const TEMPLATE_SOURCE_FORMATS = Template.shape.sourceFormat.unwrap().options;

/** Server templates: built-in Minecraft/Velocity templates and imported Pterodactyl/Pelican eggs. */
export const templates = pgTable(
  "templates",
  {
    id: uuid("id").primaryKey(),
    key: text("key").notNull().unique("templates_key_unique"),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    category: text("category").notNull(),
    kind: text("kind").notNull(),
    game: text("game").notNull(),
    author: text("author"),
    source: text("source").notNull(),
    sourceFormat: text("source_format"),
    dockerImages: jsonb("docker_images").$type<{ label: string; image: string }[]>().notNull().default([]),
    startup: text("startup").notNull().default(""),
    configFiles: jsonb("config_files").$type<ConfigFileRule[]>().notNull().default([]),
    startupDone: jsonb("startup_done").$type<string[]>().notNull().default([]),
    stop: jsonb("stop").$type<StopConfig>().notNull(),
    install: jsonb("install").$type<InstallScript>(),
    features: text("features").array().notNull().default(sql`'{}'::text[]`),
    fileDenylist: text("file_denylist").array().notNull().default(sql`'{}'::text[]`),
    runtime: jsonb("runtime").$type<{ dataMountPath: "/data" | "/home/container"; readOnlyRootfs: boolean }>().notNull(),
    /** Original egg JSON (imported templates), kept for export and re-import diffs. */
    rawImport: jsonb("raw_import"),
    createdAt: tsz("created_at").notNull().defaultNow(),
    updatedAt: tsz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    enumCheck("templates_kind_check", t.kind, TemplateKind.options),
    enumCheck("templates_game_check", t.game, TemplateGame.options),
    enumCheck("templates_source_check", t.source, ["builtin", "import"]),
    nullableEnumCheck("templates_source_format_check", t.sourceFormat, TEMPLATE_SOURCE_FORMATS),
    check("templates_key_format", sql`${t.key} ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'`),
  ],
);

export const templateVariables = pgTable(
  "template_variables",
  {
    id: uuid("id").primaryKey(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => templates.id, { onDelete: "cascade" }),
    envName: text("env_name").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    defaultValue: text("default_value").notNull().default(""),
    userViewable: boolean("user_viewable").notNull().default(true),
    userEditable: boolean("user_editable").notNull().default(false),
    rules: text("rules").notNull().default("nullable|string"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    unique("template_variables_env_unique").on(t.templateId, t.envName),
    index("template_variables_template_idx").on(t.templateId),
    check("template_variables_env_format", sql`${t.envName} ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'`),
  ],
);
