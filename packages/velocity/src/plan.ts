import { ForwardingConfigError, SECRET_BEARING_FILES, backendForwardingFiles } from "./backend-config.js";
import { unifiedDiff } from "./diff.js";
import type { NetworkIssue, NetworkModel, NetworkModelInput } from "./model.js";
import { redactFileForDisplay } from "./redact.js";
import { assessSecret, forwardingSecretFileContent } from "./secret.js";
import { TomlEditError } from "./toml/document.js";
import { TomlSyntaxError } from "./toml/lexer.js";
import { renderVelocityToml } from "./velocity-config.js";
import { validateNetwork } from "./validator.js";
import { YamlEditError } from "./yaml-edit.js";

/**
 * Deterministic change plan for a network: per server and file the current SHA-256 (for the
 * agent's `fs.write ifMatchSha256`), the new content, a unified diff (secrets redacted), whether a
 * restart or reload is needed, and an ordered rollout: backends one at a time first, the proxy
 * last (reloaded with `velocity reload`, which re-reads velocity.toml and the secret file —
 * VelocityServer#reloadConfiguration, 4.2.0). Nothing restarts all servers at once.
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
  /** Reasons the server's changes cannot be applied; nothing for it is in the rollout. */
  blocked: string[];
  notes: string[];
}

export interface RolloutStep {
  order: number;
  serverKey: string;
  action: "write-files" | "restart" | "reload";
  /** Wait for readiness (log `Done (` + ping) before the next step. */
  waitForReady: boolean;
}

export interface NetworkPlan {
  ok: boolean;
  issues: NetworkIssue[];
  servers: ServerPlan[];
  rollout: RolloutStep[];
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

export async function planNetworkChanges(input: PlanInput): Promise<NetworkPlan> {
  const validation = validateNetwork(input.model, { secret: assessSecret(input.secret) });
  const issues = validation.issues;
  const model = validation.model;
  if (!model || !model.proxy) return { ok: false, issues, servers: [], rollout: [] };

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
    try {
      const r = backendForwardingFiles({
        software: b.software,
        minecraftVersion: b.minecraftVersion,
        mode,
        secret: needsSecret ? input.secret : null,
        proxyOnlineMode: proxy.settings.onlineMode,
        files: current,
      });
      for (const path of Object.keys(r.files).sort()) {
        plan.files.push(await planFile(path, current[path] ?? null, r.files[path]!, input.secret, []));
      }
      plan.notes.push(...r.notes);
      if (r.requires.length > 0) plan.notes.push(`Requires: ${r.requires.join(", ")} (BlockForge does not install them automatically).`);
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
  if (pPlan.files.length > 0) {
    pPlan.action = "reload";
    pPlan.reloadCommand = "velocity reload";
    pPlan.notes.push("`velocity reload` applies servers, forced hosts, forwarding settings and the secret without disconnecting players on unchanged servers; restart the proxy instead if the reload reports an error.");
  }
  servers.push(pPlan);

  // ---- rollout: backends first, one at a time; proxy last ----
  const rollout: RolloutStep[] = [];
  let order = 1;
  const blockedAny = servers.some((s) => s.blocked.length > 0);
  for (const s of servers.filter((x) => x.role === "backend" && x.blocked.length === 0 && x.action !== "none")) {
    rollout.push({ order: order++, serverKey: s.key, action: "write-files", waitForReady: false });
    rollout.push({ order: order++, serverKey: s.key, action: "restart", waitForReady: true });
  }
  if (pPlan.blocked.length === 0 && pPlan.action !== "none") {
    rollout.push({ order: order++, serverKey: pPlan.key, action: "write-files", waitForReady: false });
    rollout.push({ order, serverKey: pPlan.key, action: "reload", waitForReady: false });
  }
  const ok = !issues.some((i) => i.severity === "error") && !blockedAny;
  return { ok, issues, servers, rollout };
}
