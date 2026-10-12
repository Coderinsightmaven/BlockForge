import { z } from "zod";
import { DisplayName, EpochMs, Id, Slug } from "../common.js";

/**
 * Server templates (Pterodactyl calls them "eggs").
 * - `minecraft`: built-in Java Edition template driven by the `@blockforge/minecraft` catalogue
 *   (Vanilla/Paper/Purpur/Folia/Fabric/Forge/NeoForge; software, version and build chosen per server).
 * - `velocity`: built-in Velocity proxy template.
 * - `egg`: imported Pterodactyl/Pelican egg (generic: images, startup string, variables, install script,
 *   config-file edits, done-detection). Admin-trusted: only `templates.manage` may import or edit them.
 */
export const TemplateKind = z.enum(["minecraft", "velocity", "egg"]);
export type TemplateKind = z.infer<typeof TemplateKind>;

/** Enables game-specific features (SLP status, player events, properties editor, plugin manager). */
export const TemplateGame = z.enum(["minecraft-java", "minecraft-proxy", "other"]);
export type TemplateGame = z.infer<typeof TemplateGame>;

/** Egg environment variable names (Pterodactyl allows `\w`). Platform-reserved names are rejected on import. */
export const EnvVarName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);

/**
 * Names the platform sets itself; eggs may *read* them in startup strings but cannot declare them.
 * (`SERVER_MEMORY`, `SERVER_IP`, `SERVER_PORT` follow Pterodactyl semantics so community eggs work.)
 */
export const RESERVED_ENV_VARS = [
  "STARTUP",
  "SERVER_MEMORY",
  "SERVER_IP",
  "SERVER_PORT",
  "P_SERVER_UUID",
  "P_SERVER_LOCATION",
  "P_SERVER_ALLOCATION_LIMIT",
  "TZ",
  "HOME",
  "USER",
  "JAVA_TOOL_OPTIONS",
] as const;

export const TemplateVariable = z.object({
  envName: EnvVarName,
  name: z.string().min(1).max(191),
  description: z.string().max(4096).default(""),
  defaultValue: z.string().max(8192).default(""),
  userViewable: z.boolean(),
  userEditable: z.boolean(),
  /**
   * Laravel-style rule string as found in eggs (e.g. `required|string|max:20`, `nullable|in:a,b`,
   * `regex:/^[0-9]+$/`). The supported subset is `SUPPORTED_VARIABLE_RULES`; eggs using other rules are
   * imported with a warning and those rules are reported as unenforced.
   */
  rules: z.string().max(2048).default("nullable|string"),
  sortOrder: z.number().int().default(0),
});
export type TemplateVariable = z.infer<typeof TemplateVariable>;

export const SUPPORTED_VARIABLE_RULES = [
  "required",
  "nullable",
  "sometimes",
  "string",
  "integer",
  "numeric",
  "boolean",
  "alpha",
  "alpha_num",
  "alpha_dash",
  "url",
  "ip",
  "in",
  "not_in",
  "min",
  "max",
  "between",
  "size",
  "digits",
  "digits_between",
  "regex",
] as const;

/**
 * Edits applied to a config file before every start (Pterodactyl `config.files`). `find` keys are
 * parser-specific paths; values are replacement strings with `{{…}}` placeholders, or a map of
 * `current value → replacement` (applied only when the current value matches).
 */
export const ConfigFileRule = z.object({
  path: z.string().min(1).max(512),
  parser: z.enum(["properties", "yaml", "json", "ini", "xml", "file"]),
  find: z.record(z.string().max(512), z.union([z.string().max(8192), z.record(z.string(), z.string())])),
});
export type ConfigFileRule = z.infer<typeof ConfigFileRule>;

/**
 * Placeholders supported in config-file rules and startup strings, beyond `{{ENV_NAME}}` of the
 * template's variables. Unknown placeholders are left untouched and reported at import.
 */
export const TEMPLATE_PLACEHOLDERS = [
  "server.build.default.ip",
  "server.build.default.port",
  "server.build.memory",
  "server.build.env.SERVER_IP",
  "server.build.env.SERVER_PORT",
  "server.build.env.SERVER_MEMORY",
  "server.uuid",
  "server.name",
  "config.docker.interface",
  // Pelican spellings
  "server.allocations.default.ip",
  "server.allocations.default.port",
  "server.build.memory_limit",
] as const;
/** Placeholder prefixes that take a variable name (`{{env.SAVE_NAME}}`, Pelican `{{server.environment.SAVE_NAME}}`). */
export const TEMPLATE_PLACEHOLDER_PREFIXES = ["env.", "server.build.env.", "server.environment."] as const;

export const StopConfig = z.discriminatedUnion("type", [
  /** Line written to the console (stdin). */
  z.object({ type: z.literal("command"), command: z.string().min(1).max(256).regex(/^[^\0\r\n]*$/) }),
  /** Signal sent to the container's main process (eggs write `^C` for SIGINT). */
  z.object({ type: z.literal("signal"), signal: z.enum(["SIGINT", "SIGTERM", "SIGQUIT", "SIGKILL"]) }),
]);
export type StopConfig = z.infer<typeof StopConfig>;

export const InstallScript = z.object({
  /** Install container image; must also be allowed by the node agent's image allowlist. */
  image: z.string().min(1).max(255),
  /** Shell that runs the script (`/mnt/install/install.sh`). */
  entrypoint: z.enum(["bash", "ash", "sh"]),
  script: z.string().max(64 * 1024),
});
export type InstallScript = z.infer<typeof InstallScript>;

export const DockerImageOption = z.object({ label: z.string().min(1).max(80), image: z.string().min(1).max(255) });

export const Template = z.object({
  id: Id,
  key: Slug,
  name: DisplayName,
  description: z.string().max(4096),
  /** Free-form grouping in the UI (Pterodactyl "nest"), e.g. "Minecraft", "Survival", "Source Engine". */
  category: z.string().min(1).max(80),
  kind: TemplateKind,
  game: TemplateGame,
  author: z.string().max(191).nullable(),
  source: z.enum(["builtin", "import"]),
  sourceFormat: z.enum(["PTDL_v1", "PTDL_v2", "PLCN_v1", "PLCN_v2", "PLCN_v3"]).nullable(),
  /** Empty for built-in Minecraft/Velocity templates (image follows the required Java version). */
  dockerImages: z.array(DockerImageOption).max(32),
  /** Startup string evaluated by the image's entrypoint (`STARTUP` env); empty for built-in templates. */
  startup: z.string().max(8192),
  variables: z.array(TemplateVariable).max(128),
  configFiles: z.array(ConfigFileRule).max(64),
  /** Console substrings that mark the server as started (any match). Built-ins use their own parsers. */
  startupDone: z.array(z.string().min(1).max(512)).max(16),
  stop: StopConfig,
  install: InstallScript.nullable(),
  /** Egg feature flags, e.g. "eula", "java_version", "pid_limit", "steam_disk_space" (informational in v1). */
  features: z.array(z.string().max(64)).max(32),
  /** Paths users may not edit/download via the file manager or SFTP (egg `file_denylist`). */
  fileDenylist: z.array(z.string().max(512)).max(256),
  runtime: z.object({
    /** Where the server's files appear inside the container. Eggs/yolks expect `/home/container`. */
    dataMountPath: z.enum(["/data", "/home/container"]),
    /** Read-only image filesystem (+ tmpfs /tmp). Some third-party images need `false`. */
    readOnlyRootfs: z.boolean(),
  }),
  serverCount: z.number().int().nonnegative(),
  createdAt: EpochMs,
  updatedAt: EpochMs,
});
export type Template = z.infer<typeof Template>;

/**
 * What a server creator (holder of `servers.create`) sees: no install script or config-file rules,
 * only user-viewable variables.
 */
export const TemplateSummary = Template.pick({
  id: true,
  key: true,
  name: true,
  description: true,
  category: true,
  kind: true,
  game: true,
  dockerImages: true,
  features: true,
  serverCount: true,
}).extend({ variables: z.array(TemplateVariable) });
export type TemplateSummary = z.infer<typeof TemplateSummary>;

/** `POST /templates/import/preview` and `POST /templates/import`. `egg` is the raw egg JSON object. */
export const ImportTemplateRequest = z.object({
  egg: z.record(z.string(), z.unknown()),
  category: z.string().min(1).max(80),
  game: TemplateGame.optional(),
  /** Replace the template with this key (must be an imported template). */
  replaceKey: Slug.optional(),
});
export const TemplateImportIssue = z.object({
  severity: z.enum(["error", "warning", "info"]),
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
});
export const TemplateImportPreview = z.object({
  template: Template.omit({ id: true, serverCount: true, createdAt: true, updatedAt: true }).nullable(),
  issues: z.array(TemplateImportIssue),
  /** Images that the target nodes' agents will refuse unless added to their allowlist. */
  imagesNeedingAllowlist: z.array(z.string()),
});
export type TemplateImportPreview = z.infer<typeof TemplateImportPreview>;

export const UpdateTemplateRequest = Template.pick({
  name: true,
  description: true,
  category: true,
  game: true,
  dockerImages: true,
  startup: true,
  variables: true,
  configFiles: true,
  startupDone: true,
  stop: true,
  install: true,
  fileDenylist: true,
  runtime: true,
}).partial();
