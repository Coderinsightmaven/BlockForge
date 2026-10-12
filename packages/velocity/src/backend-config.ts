import type { ServerSoftware } from "@blockforge/contracts";
import { isAtLeast, updatePropertiesText } from "@blockforge/minecraft";
import { forwardingCompatibility } from "./compat.js";
import type { ForwardingMode } from "./model.js";
import { TomlDocument } from "./toml/document.js";
import { type YamlEdit, editYaml } from "./yaml-edit.js";

/**
 * Backend-side forwarding configuration (see compat.ts for sources). Paths are relative to the
 * backend's data root.
 */
export const BACKEND_FILES = {
  serverProperties: "server.properties",
  paperGlobal: "config/paper-global.yml",
  paperLegacy: "paper.yml",
  spigot: "spigot.yml",
  bungeeGuard: "plugins/BungeeGuard/config.yml",
  fabricProxyLite: "config/FabricProxy-Lite.toml",
  pcf: "config/proxy-compatible-forge.toml",
} as const;

/** Files that may contain the forwarding secret (for redaction / sensitive diffs). */
export const SECRET_BEARING_FILES: readonly string[] = [
  "forwarding.secret",
  BACKEND_FILES.paperGlobal,
  BACKEND_FILES.paperLegacy,
  BACKEND_FILES.bungeeGuard,
  BACKEND_FILES.fabricProxyLite,
  BACKEND_FILES.pcf,
];

export function paperVelocityEdits(minecraftVersion: string, opts: { enabled: boolean; onlineMode: boolean; secret: string | null }) {
  const modern = isAtLeast(minecraftVersion, "1.19") !== false;
  const base = modern ? ["proxies", "velocity"] : ["settings", "velocity-support"];
  const edits: YamlEdit[] = [
    { path: [...base, "enabled"], value: opts.enabled },
    { path: [...base, "online-mode"], value: opts.onlineMode },
  ];
  if (opts.secret !== null) edits.push({ path: [...base, "secret"], value: opts.secret });
  return { file: modern ? BACKEND_FILES.paperGlobal : BACKEND_FILES.paperLegacy, edits };
}

/** config/paper-global.yml (≥ 1.19) or paper.yml (≤ 1.18.2) velocity section. */
export function writePaperVelocityConfig(current: string | null, minecraftVersion: string, opts: { enabled: boolean; onlineMode: boolean; secret: string | null }) {
  const { file, edits } = paperVelocityEdits(minecraftVersion, opts);
  return { path: file, ...editYaml(current, edits) };
}

/** spigot.yml `settings.bungeecord`. */
export function writeSpigotBungeecord(current: string | null, enabled: boolean) {
  return { path: BACKEND_FILES.spigot, ...editYaml(current, [{ path: ["settings", "bungeecord"], value: enabled }]) };
}

/** plugins/BungeeGuard/config.yml `allowed-tokens`. */
export function writeBungeeGuardConfig(current: string | null, token: string) {
  return { path: BACKEND_FILES.bungeeGuard, ...editYaml(current, [{ path: ["allowed-tokens"], value: [token] }]) };
}

function editToml(current: string | null, apply: (doc: TomlDocument) => void): { content: string; changed: boolean; created: boolean } {
  const created = current === null;
  const doc = TomlDocument.parse(current ?? "");
  apply(doc);
  const content = doc.toString();
  return { content, changed: content !== (current ?? ""), created };
}

/**
 * config/FabricProxy-Lite.toml — missing keys are filled with defaults by the mod (FabricProxy-Lite
 * README), so a file with just these keys is valid.
 */
export function writeFabricProxyLiteConfig(current: string | null, opts: { secret: string; hackOnlineMode?: boolean; hackEarlySend?: boolean; hackMessageChain?: boolean }) {
  return {
    path: BACKEND_FILES.fabricProxyLite,
    ...editToml(current, (doc) => {
      if (opts.hackOnlineMode !== undefined) doc.setValue("", "hackOnlineMode", opts.hackOnlineMode);
      if (opts.hackEarlySend !== undefined) doc.setValue("", "hackEarlySend", opts.hackEarlySend);
      if (opts.hackMessageChain !== undefined) doc.setValue("", "hackMessageChain", opts.hackMessageChain);
      doc.setValue("", "secret", opts.secret);
    }),
  };
}

/** config/proxy-compatible-forge.toml `[forwarding]`. */
export function writePcfConfig(current: string | null, opts: { mode: "MODERN" | "BUNGEEGUARD" | "LEGACY"; secret: string | null }) {
  return {
    path: BACKEND_FILES.pcf,
    ...editToml(current, (doc) => {
      doc.setValue("forwarding", "enabled", true);
      doc.setValue("forwarding", "mode", opts.mode);
      if (opts.secret !== null) doc.setValue("forwarding", "secret", opts.secret);
    }),
  };
}

export interface BackendForwardingInput {
  software: ServerSoftware;
  minecraftVersion: string;
  mode: ForwardingMode;
  /** Required for modern and bungeeguard. */
  secret: string | null;
  /** velocity.toml `online-mode` (Paper's `proxies.velocity.online-mode` must match it). */
  proxyOnlineMode: boolean;
  /** Current contents by path (null/absent = file does not exist yet). */
  files: Readonly<Record<string, string | null>>;
}

export interface BackendForwardingResult {
  /** New contents of every file that must change. */
  files: Record<string, string>;
  /** Files created from scratch (the server fills in its remaining defaults on next start). */
  created: string[];
  requires: string[];
  notes: string[];
  restartRequired: boolean;
}

export class ForwardingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForwardingConfigError";
  }
}

/** Computes every backend file change needed for `mode`. Throws if the mode is unsupported. */
export function backendForwardingFiles(input: BackendForwardingInput): BackendForwardingResult {
  const compat = forwardingCompatibility(input.software, input.minecraftVersion);
  const support = compat.modes[input.mode];
  if (support.level === "unsupported") throw new ForwardingConfigError(support.notes[0] ?? `${input.mode} forwarding is not supported`);
  if ((input.mode === "modern" || input.mode === "bungeeguard") && !input.secret) throw new ForwardingConfigError(`${input.mode} forwarding needs a forwarding secret`);
  const out: BackendForwardingResult = { files: {}, created: [], requires: [...support.requires], notes: [...support.notes], restartRequired: false };
  const cur = (p: string) => input.files[p] ?? null;
  const put = (r: { path: string; content: string; changed: boolean; created: boolean }) => {
    if (!r.changed) return;
    out.files[r.path] = r.content;
    if (r.created) out.created.push(r.path);
    out.restartRequired = true;
  };

  // Every proxied backend runs in offline mode; the proxy authenticates players.
  const props = cur(BACKEND_FILES.serverProperties) ?? "";
  const newProps = updatePropertiesText(props, { "online-mode": false });
  if (newProps !== props) put({ path: BACKEND_FILES.serverProperties, content: newProps, changed: true, created: props === "" });

  const paperFamily = ["paper", "purpur", "folia"].includes(input.software);
  const spigotLike = paperFamily || input.software === "spigot";
  if (paperFamily) {
    const { file } = paperVelocityEdits(input.minecraftVersion, { enabled: false, onlineMode: input.proxyOnlineMode, secret: null });
    if (input.mode === "modern") {
      put(writePaperVelocityConfig(cur(file), input.minecraftVersion, { enabled: true, onlineMode: input.proxyOnlineMode, secret: input.secret }));
    } else if (cur(file) !== null) {
      // Turn modern forwarding off if a previous plan enabled it (keeps the secret value out of use).
      put(writePaperVelocityConfig(cur(file), input.minecraftVersion, { enabled: false, onlineMode: input.proxyOnlineMode, secret: null }));
    }
  }
  if (spigotLike) {
    const want = input.mode === "legacy" || input.mode === "bungeeguard";
    if (want || cur(BACKEND_FILES.spigot) !== null) put(writeSpigotBungeecord(cur(BACKEND_FILES.spigot), want));
    if (input.mode === "bungeeguard") put(writeBungeeGuardConfig(cur(BACKEND_FILES.bungeeGuard), input.secret!));
  }
  if (input.software === "fabric" && input.mode === "modern") {
    put(writeFabricProxyLiteConfig(cur(BACKEND_FILES.fabricProxyLite), { secret: input.secret! }));
  }
  if ((input.software === "forge" || input.software === "neoforge") && input.mode !== "none" && support.requires.some((r) => r.startsWith("Proxy Compatible Forge"))) {
    const mode = input.mode === "modern" ? "MODERN" : input.mode === "bungeeguard" ? "BUNGEEGUARD" : "LEGACY";
    put(writePcfConfig(cur(BACKEND_FILES.pcf), { mode, secret: input.mode === "legacy" ? null : input.secret }));
  }
  if (out.created.some((p) => p !== BACKEND_FILES.serverProperties)) {
    out.notes.push(`Created ${out.created.join(", ")} with only the forwarding keys; the server adds its remaining defaults on the next start (not verified for every version).`);
  }
  return out;
}
