import { ForwardingConfigError, SECRET_BEARING_FILES, backendForwardingFiles } from "./backend-config.js";
import { conflictingExtensions, forwardingCompatibility } from "./compat.js";
import { unifiedDiff } from "./diff.js";
import type { NetworkIssue, NetworkModel, NetworkModelInput } from "./model.js";
import { redactFileForDisplay } from "./redact.js";
import { assessSecret, forwardingSecretFileContent } from "./secret.js";
import { TomlDocument, TomlEditError } from "./toml/document.js";
import { TomlSyntaxError } from "./toml/lexer.js";
import { renderVelocityToml } from "./velocity-config.js";
import { validateNetwork } from "./validator.js";
import { YamlEditError } from "./yaml-edit.js";

/**
 * Deterministic change plan for a network: per server and file the current SHA-256 (for the
 * agent's `fs.write ifMatchSha256`), the new content, a unified diff (secrets redacted), the
 * action each server needs, and an ordered rollout.
 *
 * Strategy:
 *  - `coordinated` — the proxy's forwarding mode, secret, online-mode or force-key-authentication
 *    changes. Proxy and backends must switch together: a backend that already expects the new
 *    secret rejects the old proxy and vice versa, so a rolling rollout causes login failures and
 *    split-brain. The rollout is maintenance-gated: stop the proxy (players are disconnected), write
 *    every affected file, restart the affected backends (may run in parallel, nobody is online),
 *    then start the proxy. Velocity and Paper accept exactly one secret, so dual-secret staging is
 *    not possible.
 *  - `rolling` — the proxy's forwarding settings stay the same: each backend converges to them on
 *    its own (one at a time, waiting for readiness), then the proxy is reloaded (`velocity reload`
 *    re-reads servers and forced hosts — VelocityServer#reloadConfiguration, 4.2.0).
 * Any validation error or blocked server yields an empty rollout (all-or-nothing).
 */

export interface PlannedFile {
  path: string;
  /** SHA-256 of the current content; null = file does not exist (write with ifMatchSha256: null). */
  beforeSha256: string | null;
  afterContent: string;
  afterSha256: string;
  /** Unified diff for display. Secret values are redacted. */
  diff: string;
  /** File carries the forwarding secret: never log `afterContent`, show only `diff`. */
  sensitive: boolean;
}

export type ServerAction = "none" | "restart" | "reload";

export interface ServerPlan {
  key: string;
  role: "proxy" | "backend";
  name: string;
  files: PlannedFile[];
  action: ServerAction;
  /** Console command for `reload` actions. */
  reloadCommand: string | null;
  /** Reasons the server's changes cannot be applied; any blocked server empties the rollout. */
  blocked: string[];
  notes: string[];
}

export interface RolloutStep {
  order: number;
  /** Steps with the same group may run concurrently; groups run strictly in order. */
  group: number;
  serverKey: string;
  action: "write-files" | "restart" | "reload" | "stop" | "start";
  /** Wait for readiness (log `Done (` + ping) before the next group. */
  waitForReady: boolean;
}

export type RolloutStrategy = "none" | "rolling" | "coordinated";

export interface NetworkPlan {
  ok: boolean;
  issues: NetworkIssue[];
  servers: ServerPlan[];
  strategy: RolloutStrategy;
  /** Coordinated transitions disconnect every player for the duration (maintenance window). */
  requiresMaintenance: boolean;
  rollout: RolloutStep[];
  notes: string[];
}

export interface PlanInput {
  model: NetworkModelInput | NetworkModel;
  /**
   * Current file contents keyed by server key, then path (null = file absent). Server keys: the
   * proxy's `serverId` (or "proxy"), each backend's `serverId` (or its name).
   */
  current: Readonly<Record<string, Readonly<Record<string, string | null>>>>;
  /** Forwarding secret (from the secrets store). Only written to secret-bearing files. */
  secret: string | null;
  /**
   * Installed plugin/mod ids (Modrinth slugs, e.g. "fabricproxy-lite") per server key; `null` or
   * absent = unknown. Backends whose forwarding needs an extension are blocked unless it is listed.
   */
  extensions?: Readonly<Record<string, readonly string[] | null>>;
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function planFile(path: string, before: string | null, after: string, secret: string | null, extraSecretFiles: string[]): Promise<PlannedFile> {
  const sensitive = SECRET_BEARING_FILES.includes(path) || extraSecretFiles.includes(path);
  const known = secret ? [secret] : [];
  const show = (t: string) => (sensitive || known.length > 0 ? redactFileForDisplay(path, t, { knownSecrets: known, secretFiles: extraSecretFiles }).content : t);
  return {
    path,
    beforeSha256: before === null ? null : await sha256Hex(before),
    afterContent: after,
    afterSha256: await sha256Hex(after),
    diff: unifiedDiff(before === null ? "" : show(before), show(after), { oldPath: path, newPath: path, oldMissing: before === null }),
    sensitive,
  };
}

interface ProxyAuthState {
  mode: string | null;
  onlineMode: boolean | null;
  forceKeyAuthentication: boolean | null;
  secret: string | null;
}

function currentProxyAuth(velocityToml: string | null, files: Readonly<Record<string, string | null>>): ProxyAuthState | null {
  if (velocityToml === null) return null;
  try {
    const doc = TomlDocument.parse(velocityToml);
    const mode = doc.get("", "player-info-forwarding-mode");
    const online = doc.get("", "online-mode");
    const fka = doc.get("", "force-key-authentication");
    const secretFile = doc.get("", "forwarding-secret-file");
    const raw = files[typeof secretFile === "string" ? secretFile : "forwarding.secret"] ?? null;
    return {
      mode: typeof mode === "string" ? mode.toLowerCase() : null,
      onlineMode: typeof online === "boolean" ? online : null,
      forceKeyAuthentication: typeof fka === "boolean" ? fka : null,
      // Velocity reads the file with String.join("", readAllLines(path))
      secret: raw === null ? null : raw.replace(/\r?\n/g, ""),
    };
  } catch {
    return null;
  }
}

export async function planNetworkChanges(input: PlanInput): Promise<NetworkPlan> {
  const validation = validateNetwork(input.model, { secret: assessSecret(input.secret) });
  const issues = validation.issues;
  const model = validation.model;
  const empty = (notes: string[] = []): NetworkPlan => ({ ok: false, issues, servers: [], strategy: "none", requiresMaintenance: false, rollout: [], notes });
  if (!model || !model.proxy) return empty();

  const servers: ServerPlan[] = [];
  const proxy = model.proxy;
  const mode = proxy.settings.forwardingMode;
  const needsSecret = mode === "modern" || mode === "bungeeguard";
  const secretFile = proxy.settings.forwardingSecretFile;
  const extraSecretFiles = secretFile === "forwarding.secret" ? [] : [secretFile];

  // ---- backends (model order) ----
  for (const b of model.backends) {
    const key = b.serverId ?? b.name;
    const plan: ServerPlan = { key, role: "backend", name: b.name, files: [], action: "none", reloadCommand: null, blocked: [], notes: [] };
    servers.push(plan);
    if (!b.inNetwork) {
      plan.notes.push("Not a member of this network; its files are not changed.");
      continue;
    }
    const current = input.current[key] ?? {};
    const installed = input.extensions?.[key] ?? null;

    // Preflight: required and conflicting plugins/mods.
    const support = forwardingCompatibility(b.software, b.minecraftVersion).modes[mode];
    if (support.requiredExtensions.length > 0) {
      if (installed === null) {
        plan.blocked.push(`${mode} forwarding needs ${support.requiredExtensions.map((e) => e.name).join(" + ")}; the installed plugins/mods of this server are unknown.`);
      } else {
        const missing = support.requiredExtensions.filter((e) => !installed.includes(e.id));
        if (missing.length > 0) plan.blocked.push(`Install ${missing.map((e) => `${e.name} (${e.id})`).join(", ")} before switching to ${mode} forwarding.`);
      }
    }
    if (installed !== null) {
      const conflicts = conflictingExtensions(b.software, mode).filter((e) => installed.includes(e.id));
      if (conflicts.length > 0) plan.blocked.push(`Remove ${conflicts.map((e) => `${e.name} (${e.id})`).join(", ")}: it is incompatible with ${mode} forwarding.`);
    }

    try {
      const r = backendForwardingFiles({
        software: b.software,
        minecraftVersion: b.minecraftVersion,
        mode,
        secret: needsSecret ? input.secret : null,
        proxyOnlineMode: proxy.settings.onlineMode,
        proxyForceKeyAuthentication: proxy.settings.forceKeyAuthentication,
        installedExtensions: installed,
        files: current,
      });
      for (const path of Object.keys(r.files).sort()) {
        plan.files.push(await planFile(path, current[path] ?? null, r.files[path]!, input.secret, []));
      }
      plan.notes.push(...r.notes);
      if (plan.files.length > 0) plan.action = "restart";
    } catch (e) {
      if (e instanceof ForwardingConfigError || e instanceof TomlEditError || e instanceof TomlSyntaxError || e instanceof YamlEditError) {
        plan.blocked.push((e as Error).message);
      } else throw e;
    }
  }

  // ---- proxy ----
  const proxyKey = proxy.serverId ?? "proxy";
  const pPlan: ServerPlan = { key: proxyKey, role: "proxy", name: proxy.name, files: [], action: "none", reloadCommand: null, blocked: [], notes: [] };
  const pCurrent = input.current[proxyKey] ?? {};
  const velocityToml = pCurrent["velocity.toml"] ?? null;
  if (velocityToml === null) {
    pPlan.blocked.push("velocity.toml does not exist yet: start the proxy once so Velocity writes its version-specific default configuration, then plan again.");
  } else {
    try {
      const rendered = renderVelocityToml(velocityToml, { ...model, forcedHosts: validation.forcedHosts });
      pPlan.notes.push(...rendered.notes);
      if (rendered.content !== velocityToml) pPlan.files.push(await planFile("velocity.toml", velocityToml, rendered.content, input.secret, extraSecretFiles));
    } catch (e) {
      pPlan.blocked.push(`velocity.toml could not be edited: ${(e as Error).message}`);
    }
  }
  if (needsSecret && input.secret) {
    const content = forwardingSecretFileContent(input.secret);
    const before = pCurrent[secretFile] ?? null;
    if (before !== content) pPlan.files.push(await planFile(secretFile, before, content, input.secret, extraSecretFiles));
  }
  servers.push(pPlan);

  // ---- strategy ----
  const now = currentProxyAuth(velocityToml, pCurrent);
  const authChanged =
    now !== null &&
    (now.mode !== mode ||
      now.onlineMode !== proxy.settings.onlineMode ||
      now.forceKeyAuthentication !== proxy.settings.forceKeyAuthentication ||
      (needsSecret && now.secret !== input.secret));
  const backendsChanging = servers.filter((s) => s.role === "backend" && s.action !== "none");
  const notes: string[] = [];
  let strategy: RolloutStrategy = "none";
  if (authChanged) strategy = "coordinated";
  else if (backendsChanging.length > 0 || pPlan.files.length > 0) strategy = "rolling";

  if (strategy === "coordinated") {
    pPlan.action = "restart";
    pPlan.reloadCommand = null;
    notes.push(
      "The proxy's forwarding settings change: proxy and backends switch together in a maintenance window (the proxy is stopped, so every player is disconnected until it starts again).",
      "If any step fails, restore every written file from its previous content (beforeSha256) and start the proxy again.",
    );
  } else if (pPlan.files.length > 0) {
    pPlan.action = "reload";
    pPlan.reloadCommand = "velocity reload";
    pPlan.notes.push("`velocity reload` applies servers and forced hosts without disconnecting players on unchanged servers; restart the proxy instead if the reload reports an error.");
  }

  const blocked = servers.filter((s) => s.blocked.length > 0);
  const errors = issues.filter((i) => i.severity === "error");
  if (blocked.length > 0 || errors.length > 0) {
    notes.push(`Nothing will be applied: ${errors.length} validation error(s), ${blocked.length} blocked server(s).`);
    return { ok: false, issues, servers, strategy, requiresMaintenance: strategy === "coordinated", rollout: [], notes };
  }

  const rollout: RolloutStep[] = [];
  let order = 1;
  let group = 1;
  const step = (serverKey: string, action: RolloutStep["action"], waitForReady: boolean, g: number) => rollout.push({ order: order++, group: g, serverKey, action, waitForReady });
  if (strategy === "coordinated") {
    step(pPlan.key, "stop", false, group++);
    const writeGroup = group++;
    for (const s of backendsChanging) step(s.key, "write-files", false, writeGroup);
    if (pPlan.files.length > 0) step(pPlan.key, "write-files", false, writeGroup);
    if (backendsChanging.length > 0) {
      const restartGroup = group++;
      for (const s of backendsChanging) step(s.key, "restart", true, restartGroup);
    }
    step(pPlan.key, "start", true, group);
  } else if (strategy === "rolling") {
    for (const s of backendsChanging) {
      step(s.key, "write-files", false, group++);
      step(s.key, "restart", true, group++);
    }
    if (pPlan.files.length > 0) {
      step(pPlan.key, "write-files", false, group++);
      step(pPlan.key, "reload", false, group);
    }
  }
  return { ok: true, issues, servers, strategy, requiresMaintenance: strategy === "coordinated", rollout, notes };
}
