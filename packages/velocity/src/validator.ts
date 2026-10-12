import { forwardingCompatibility } from "./compat.js";
import { validateForcedHosts } from "./forced-hosts.js";
import { type ForcedHostMapping, type NetworkIssue, NetworkModel, type NetworkModelInput, type PublishedPort } from "./model.js";
import type { SecretAssessment } from "./secret.js";

export interface NetworkValidation {
  ok: boolean;
  issues: NetworkIssue[];
  /** Parsed model (null when the input did not match the schema). */
  model: NetworkModel | null;
  /** Valid forced hosts with normalised hostnames (what gets written to velocity.toml). */
  forcedHosts: ForcedHostMapping[];
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

function inV4(ip: number, cidr: string): boolean {
  const [base, bits] = cidr.split("/");
  const b = ipv4ToInt(base!)!;
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ip & mask) >>> 0 === (b & mask) >>> 0;
}

/** Where a host binding is reachable from: loopback, private network or (potentially) the internet. */
export function bindExposure(hostIp: string): "loopback" | "private" | "public" {
  const ip = hostIp.trim().toLowerCase();
  if (ip === "0.0.0.0" || ip === "::" || ip === "[::]") return "public";
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) {
    if (inV4(v4, "127.0.0.0/8")) return "loopback";
    if (["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16"].some((c) => inV4(v4, c))) return "private";
    return "public";
  }
  if (ip === "::1") return "loopback";
  if (/^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip)) return "private";
  return "public";
}

function overlaps(a: PublishedPort, b: PublishedPort): boolean {
  if (a.hostPort !== b.hostPort || a.nodeId !== b.nodeId) return false;
  const wild = (ip: string) => ip === "0.0.0.0" || ip === "::";
  return a.hostIp === b.hostIp || wild(a.hostIp) || wild(b.hostIp);
}

function validBind(bind: string): boolean {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(bind);
  if (!m) return false;
  const port = Number(m[3]);
  return port >= 1 && port <= 65535;
}

/**
 * Structured network checks. Codes are stable identifiers for the UI; messages are English text.
 * `secret` is an assessment only — the validator never sees the secret.
 */
export function validateNetwork(input: NetworkModelInput | NetworkModel, opts: { secret?: SecretAssessment | null } = {}): NetworkValidation {
  const issues: NetworkIssue[] = [];
  const add = (severity: NetworkIssue["severity"], code: string, subject: string, message: string) => issues.push({ severity, code, subject, message });

  const parsed = NetworkModel.safeParse(input);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      const path = i.path.join(".");
      const code = path.includes("name") && path.startsWith("backends") ? "INVALID_BACKEND_NAME" : "MODEL_INVALID";
      add("error", code, path || "network", i.message);
    }
    return { ok: false, issues, model: null, forcedHosts: [] };
  }
  const model = parsed.data;
  const proxy = model.proxy;
  const mode = proxy?.settings.forwardingMode ?? null;

  // --- proxy ---------------------------------------------------------------------------------
  if (!proxy) add("error", "NO_PROXY", "network", "The network has no Velocity proxy.");
  else {
    if (!validBind(proxy.settings.bind)) add("error", "PROXY_BIND_INVALID", "proxy", `bind "${proxy.settings.bind}" is not a valid host:port.`);
    if (!proxy.settings.onlineMode) {
      add("warning", "PROXY_OFFLINE_MODE", "proxy", "The proxy runs with online-mode=false: players are not authenticated with Mojang, so anyone can join with any name (cracked/offline accounts).");
    }
    if (!proxy.published) add("warning", "PROXY_NOT_PUBLISHED", "proxy", "The proxy has no published port; players cannot reach it.");
    if (mode === "none") add("warning", "FORWARDING_DISABLED", "proxy", "Player-info forwarding is off: backends see the proxy's IP and offline-mode UUIDs for every player.");
    if (mode === "bungeeguard") add("info", "BUNGEEGUARD_FORWARDING", "proxy", "BungeeGuard adds a token to legacy forwarding; prefer modern forwarding when every backend is 1.13+.");
    if (mode === "modern" || mode === "bungeeguard") {
      const s = opts.secret ?? null;
      if (!s || !s.present) add("error", "SECRET_MISSING", "proxy", `${mode} forwarding requires a forwarding secret.`);
      else if (!s.strong) add("warning", "SECRET_WEAK", "proxy", s.problems.join(" "));
    }
  }

  // --- backends ------------------------------------------------------------------------------
  if (model.backends.length === 0) add("warning", "NO_BACKENDS", "network", "The network has no backend servers.");
  const names = new Map<string, number>();
  for (const b of model.backends) names.set(b.name, (names.get(b.name) ?? 0) + 1);
  for (const [n, count] of names) if (count > 1) add("error", "DUPLICATE_BACKEND_NAME", n, `Backend name "${n}" is used ${count} times.`);
  const addrs = new Map<string, string[]>();
  for (const b of model.backends) {
    const k = `${b.host.toLowerCase()}:${b.port}`;
    addrs.set(k, [...(addrs.get(k) ?? []), b.name]);
  }
  for (const [k, ns] of addrs) if (ns.length > 1) add("warning", "DUPLICATE_BACKEND_ADDRESS", ns.join(","), `Backends ${ns.join(", ")} all point at ${k}.`);

  const versions = new Set<string>();
  for (const b of model.backends) {
    versions.add(b.minecraftVersion);
    if (b.software === "velocity") {
      add("error", "BACKEND_IS_PROXY", b.name, "A Velocity proxy cannot be registered as a backend server.");
      continue;
    }
    if (b.published) {
      const exposure = bindExposure(b.published.hostIp);
      if (exposure === "public" && b.onlineMode === false) {
        add(
          "error",
          "BACKEND_PUBLIC_OFFLINE",
          b.name,
          `Backend is published on ${b.published.hostIp}:${b.published.hostPort} with online-mode=false: players can bypass the proxy${mode === "modern" ? " (modern forwarding rejects unforwarded logins, but the port should still be private)" : " and join as anyone"}. Bind it to a private interface or the internal network only.`,
        );
      } else if (exposure === "public") {
        add("warning", "BACKEND_PUBLICLY_REACHABLE", b.name, `Backend is published on ${b.published.hostIp}:${b.published.hostPort}; players can connect directly, bypassing the proxy.`);
      }
    }
    if (b.onlineMode === true) {
      const fabricHack = b.software === "fabric" && mode === "modern";
      add(
        fabricHack ? "warning" : "error",
        "BACKEND_ONLINE_MODE",
        b.name,
        fabricHack
          ? "Backend has online-mode=true; FabricProxy-Lite's hackOnlineMode tolerates this, but online-mode=false is the documented setup."
          : "Backend has online-mode=true; behind the proxy it must be false (the proxy authenticates players).",
      );
    }
    if (mode) {
      const compat = forwardingCompatibility(b.software, b.minecraftVersion);
      const s = compat.modes[mode];
      if (s.level === "unsupported") add("error", "FORWARDING_UNSUPPORTED", b.name, `${b.software} ${b.minecraftVersion} cannot use ${mode} forwarding: ${s.notes[0] ?? ""}`.trim());
      else if (s.level === "unknown") add("warning", "FORWARDING_SUPPORT_UNKNOWN", b.name, s.notes[0] ?? `${mode} forwarding support for ${b.software} ${b.minecraftVersion} is unconfirmed.`);
      else if (s.level === "mod" || s.level === "plugin") add("info", "FORWARDING_REQUIRES_EXTENSION", b.name, `Requires ${s.requires.join(" + ")} on ${b.name}.`);
      if (mode === "legacy" || mode === "bungeeguard") {
        const exposed = b.published ? bindExposure(b.published.hostIp) : "internal";
        if (mode === "legacy" && exposed === "public") {
          add("error", "LEGACY_FORWARDING_WITHOUT_ISOLATION", b.name, "Legacy forwarding with a publicly reachable backend lets anyone spoof any player (including operators). Make the backend reachable only from the proxy.");
        } else if (mode === "legacy") {
          add("info", "LEGACY_FORWARDING_INSECURE", b.name, "Legacy forwarding relies entirely on network isolation; keep this backend reachable only from the proxy.");
        }
      }
    }
  }
  if (versions.size > 1) {
    add("info", "MIXED_MINECRAFT_VERSIONS", "network", `Backends run different Minecraft versions (${[...versions].join(", ")}); clients on other versions need ViaVersion/ViaBackwards-style protocol plugins.`);
  }

  // --- try list ------------------------------------------------------------------------------
  const byName = new Map(model.backends.map((b) => [b.name, b]));
  if (model.try.length === 0) {
    add(model.forcedHosts.length === 0 ? "error" : "warning", "NO_DEFAULT_SERVER", "network", "The try list is empty: players who do not match a forced host have no server to join.");
  }
  const seenTry = new Set<string>();
  for (const t of model.try) {
    if (seenTry.has(t)) add("warning", "TRY_DUPLICATE", t, `"${t}" appears more than once in the try list.`);
    seenTry.add(t);
    const b = byName.get(t);
    if (!b) add("error", "TRY_TARGET_UNKNOWN", t, `Try-list entry "${t}" is not a registered backend.`);
    else if (!b.inNetwork) add("warning", "TRY_TARGET_NOT_IN_NETWORK", t, `Try-list entry "${t}" is not a member of this network.`);
    else if (b.state === "stopped" || b.state === "crashed") add("warning", "TRY_TARGET_DOWN", t, `Try-list entry "${t}" is ${b.state}.`);
  }

  // --- forced hosts --------------------------------------------------------------------------
  const fh = validateForcedHosts(model.forcedHosts, model.backends);
  issues.push(...fh.issues);

  // --- port conflicts --------------------------------------------------------------------------
  const published: Array<{ who: string; p: PublishedPort }> = [];
  if (proxy?.published) published.push({ who: "proxy", p: proxy.published });
  for (const b of model.backends) if (b.published) published.push({ who: b.name, p: b.published });
  for (let i = 0; i < published.length; i++) {
    for (let j = i + 1; j < published.length; j++) {
      const a = published[i]!;
      const c = published[j]!;
      if (overlaps(a.p, c.p)) {
        add("error", "DUPLICATE_HOST_PORT", `${a.who},${c.who}`, `${a.who} and ${c.who} both publish port ${a.p.hostPort} on node ${a.p.nodeId ?? "(unknown)"}.`);
      }
    }
  }

  return { ok: !issues.some((i) => i.severity === "error"), issues, model, forcedHosts: fh.mappings };
}
