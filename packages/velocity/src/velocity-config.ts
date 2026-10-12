import type { BackendServer, ForcedHostMapping, NetworkModel, ProxySettings } from "./model.js";
import { TomlDocument, type TomlEntry } from "./toml/document.js";

/**
 * Model → velocity.toml edits.
 *
 * Key names follow the real default config shipped in Velocity 4.2.0 (`default-velocity.toml`,
 * config-version "2.9"; byte-identical in the jar and in the repo at the release commit).
 * Notes from the 4.2.0 sources:
 *  - Velocity runs config migrations keyed on `config-version` and autosaves the file, so the
 *    editor never writes a velocity.toml from scratch — it edits the file Velocity generated.
 *  - `ping-passthrough` is a table of booleans since config 2.9 (PingPassthroughMigration);
 *    older configs use a string (DISABLED | MODS | DESCRIPTION | ALL).
 *  - The secret lives only in `forwarding-secret-file`; a pre-2.0 `forwarding-secret` key is
 *    removed (ForwardingMigration treats it as a security hazard). Velocity also honours the
 *    VELOCITY_FORWARDING_SECRET env var, which BlockForge does not use (env is visible in
 *    `docker inspect`).
 */

export class VelocityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VelocityConfigError";
  }
}

export function formatHostPort(host: string, port: number): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`;
}

export function configVersion(doc: TomlDocument): number | null {
  const v = doc.get("", "config-version");
  if (typeof v !== "string") return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function legacyPingPassthrough(p: ProxySettings["pingPassthrough"]): { value: string; exact: boolean } {
  if (p.version && p.players && p.description && p.favicon && p.modinfo) return { value: "ALL", exact: true };
  if (p.description && p.modinfo && !p.version && !p.players && !p.favicon) return { value: "DESCRIPTION", exact: true };
  if (p.modinfo && !p.description && !p.version && !p.players && !p.favicon) return { value: "MODS", exact: true };
  if (!p.version && !p.players && !p.description && !p.favicon && !p.modinfo) return { value: "DISABLED", exact: true };
  return { value: p.description ? "DESCRIPTION" : p.modinfo ? "MODS" : "DISABLED", exact: false };
}

/** Applies proxy-level settings. Returns notes about approximations. */
export function applyProxySettings(doc: TomlDocument, s: ProxySettings): string[] {
  const notes: string[] = [];
  doc.setValue("", "bind", s.bind);
  doc.setValue("", "motd", s.motd);
  doc.setValue("", "show-max-players", s.showMaxPlayers);
  doc.setValue("", "online-mode", s.onlineMode);
  doc.setValue("", "force-key-authentication", s.forceKeyAuthentication);
  doc.setValue("", "player-info-forwarding-mode", s.forwardingMode.toUpperCase());
  doc.setValue("", "forwarding-secret-file", s.forwardingSecretFile);
  if (doc.removeKey("", "forwarding-secret")) notes.push("Removed the deprecated inline `forwarding-secret` key; the secret now lives only in the secret file.");
  doc.setValue("", "announce-forge", s.announceForge);
  doc.setValue("", "kick-existing-players", s.kickExistingPlayers);

  const legacyPing = doc.has("", "ping-passthrough");
  if (legacyPing) {
    const lp = legacyPingPassthrough(s.pingPassthrough);
    doc.setValue("", "ping-passthrough", lp.value);
    if (!lp.exact) notes.push(`This Velocity version only supports DISABLED/MODS/DESCRIPTION/ALL ping passthrough; using ${lp.value}.`);
  } else {
    const p = s.pingPassthrough;
    doc.setValue("ping-passthrough", "version", p.version);
    doc.setValue("ping-passthrough", "players", p.players);
    doc.setValue("ping-passthrough", "description", p.description);
    doc.setValue("ping-passthrough", "favicon", p.favicon);
    doc.setValue("ping-passthrough", "modinfo", p.modinfo);
  }

  doc.setValue("advanced", "compression-threshold", s.compressionThreshold);
  doc.setValue("advanced", "compression-level", s.compressionLevel);
  doc.setValue("advanced", "connection-timeout", s.connectionTimeoutMs);
  doc.setValue("advanced", "read-timeout", s.readTimeoutMs);
  doc.setValue("query", "enabled", s.query.enabled);
  doc.setValue("query", "port", s.query.port);
  return notes;
}

/** Rewrites `[servers]` with the backends (model order) and the `try` list. */
export function applyServers(doc: TomlDocument, backends: readonly Pick<BackendServer, "name" | "host" | "port">[], tryOrder: readonly string[]): void {
  const entries: TomlEntry[] = backends.map((b) => ({ key: b.name, value: formatHostPort(b.host, b.port) }));
  entries.push({ key: "try", value: [...tryOrder] });
  doc.replaceTableBody("servers", entries);
}

/** Rewrites `[forced-hosts]`; hostnames must already be normalised. */
export function applyForcedHosts(doc: TomlDocument, mappings: readonly ForcedHostMapping[]): void {
  doc.replaceTableBody(
    "forced-hosts",
    mappings.map((m) => ({ key: m.hostname, value: [...m.targets] })),
  );
}

export interface RenderedVelocityConfig {
  content: string;
  configVersion: number | null;
  notes: string[];
}

/**
 * Applies the whole network model to the proxy's current velocity.toml. Forced-host names must be
 * normalised (see validateForcedHosts). The forwarding secret is not an input, so it can never end
 * up in velocity.toml.
 */
export function renderVelocityToml(current: string, model: NetworkModel): RenderedVelocityConfig {
  if (!model.proxy) throw new VelocityConfigError("the network has no proxy");
  const doc = TomlDocument.parse(current);
  const version = configVersion(doc);
  const notes = applyProxySettings(doc, model.proxy.settings);
  // Every registered backend stays in [servers] (including ones flagged `inNetwork: false`), so
  // forced hosts / try entries that still reference them keep passing Velocity's validate().
  applyServers(doc, model.backends, model.try);
  applyForcedHosts(doc, model.forcedHosts);
  if (version === null) notes.push("velocity.toml has no config-version; Velocity will run its migrations on start and may rewrite the file.");
  return { content: doc.toString(), configVersion: version, notes };
}
