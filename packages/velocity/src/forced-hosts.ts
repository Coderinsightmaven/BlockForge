import type { BackendServer, ForcedHostMapping, NetworkIssue } from "./model.js";

/**
 * Forced hosts.
 *
 * How Velocity matches (verified in the 4.2.0 sources, commit c10b4925):
 *  - `VelocityConfiguration.ForcedHosts` stores keys with `toLowerCase(Locale.ROOT)`;
 *  - `ConnectedPlayer#getNextServerToTry` looks up `virtualHost.getHostString().toLowerCase()`
 *    with `Map.getOrDefault` — an exact string match, no wildcards or suffix matching;
 *  - `HandshakeSessionHandler.cleanVhost` cuts the handshake host at the first NUL (Forge/
 *    BungeeCord markers) and strips one trailing dot, which clients send when they followed an
 *    SRV record (they then send the SRV *target* host);
 *  - `validate()` rejects forced hosts with an empty server list or unknown server names.
 */

export interface NormalizedHostname {
  ok: boolean;
  /** Lowercase ASCII (punycode) form stored in velocity.toml. */
  hostname: string | null;
  error: string | null;
  warnings: string[];
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** IDNA 2003 (Java's java.net.IDN) and UTS #46 non-transitional processing disagree on these. */
const IDNA_DEVIATIONS = /[ßς‌‍]/;

/**
 * Normalises a forced-host name: trim, lowercase, strip one trailing dot, IDNA → ASCII via the
 * WHATWG URL host parser (UTS #46, same in Node and browsers), then RFC 1123 checks.
 */
export function normalizeHostname(input: string): NormalizedHostname {
  const warnings: string[] = [];
  const fail = (error: string): NormalizedHostname => ({ ok: false, hostname: null, error, warnings });
  let h = input.trim();
  if (h === "") return fail("Hostname is empty.");
  if (h.includes("*")) return fail("Wildcards are not supported: Velocity matches forced hosts exactly.");
  if (/[\s/\\@:?#[\]%<>"'`^{}|,;=]/.test(h)) return fail("Hostname contains characters that are not allowed (no ports, paths, spaces or brackets).");
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.startsWith(".") || h.includes("..")) return fail("Hostname has an empty label.");
  if (IDNA_DEVIATIONS.test(h)) {
    warnings.push("Contains ß/ς/zero-width joiners: IDNA 2003 (Java) and IDNA 2008/UTS 46 encode these differently, so clients may send a different name.");
  }
  let ascii: string;
  try {
    ascii = new URL(`http://${h}/`).hostname;
  } catch {
    return fail("Not a valid hostname (IDNA conversion failed).");
  }
  if (ascii.startsWith("[")) return fail("IPv6 literals are not supported as forced hosts.");
  if (IPV4.test(ascii)) {
    if (ascii !== h.toLowerCase()) return fail("Use the canonical dotted-decimal form of the IP address.");
    warnings.push("This is an IP address: it only matches players who connect by typing exactly this IP.");
    return { ok: true, hostname: ascii, error: null, warnings };
  }
  if (ascii.length > 253) return fail("Hostname is longer than 253 characters.");
  const labels = ascii.split(".");
  for (const l of labels) {
    if (l.length === 0 || l.length > 63) return fail("Each label must be 1–63 characters.");
    if (!LABEL.test(l)) return fail(`Label "${l}" is not valid (letters, digits and inner hyphens only).`);
  }
  if (/^\d+$/.test(labels[labels.length - 1]!)) return fail("The top-level label must not be all-numeric.");
  if (labels.length === 1) warnings.push("Single-label name: it is not resolvable through public DNS.");
  if (ascii !== h.toLowerCase()) warnings.push(`Stored as "${ascii}" (ASCII form). Velocity compares the exact host name the client sends.`);
  return { ok: true, hostname: ascii, error: null, warnings };
}

export interface ForcedHostValidation {
  /** Valid mappings with normalised hostnames, in input order (first occurrence wins). */
  mappings: ForcedHostMapping[];
  issues: NetworkIssue[];
}

export function validateForcedHosts(mappings: readonly ForcedHostMapping[], backends: readonly Pick<BackendServer, "name" | "state" | "inNetwork">[]): ForcedHostValidation {
  const issues: NetworkIssue[] = [];
  const out: ForcedHostMapping[] = [];
  const byHost = new Map<string, { targets: string[]; input: string }>();
  const backendByName = new Map(backends.map((b) => [b.name, b]));

  for (const m of mappings) {
    const n = normalizeHostname(m.hostname);
    const subject = n.hostname ?? m.hostname.trim();
    for (const w of n.warnings) issues.push({ severity: "warning", code: "FORCED_HOST_NOTE", message: w, subject });
    if (!n.ok || !n.hostname) {
      issues.push({ severity: "error", code: m.hostname.includes("*") ? "FORCED_HOST_WILDCARD" : "FORCED_HOST_INVALID", message: n.error ?? "Invalid hostname.", subject });
      continue;
    }
    const prev = byHost.get(n.hostname);
    if (prev) {
      const same = prev.targets.length === m.targets.length && prev.targets.every((t, i) => t === m.targets[i]);
      issues.push({
        severity: "error",
        code: same ? "FORCED_HOST_DUPLICATE" : "FORCED_HOST_CONFLICT",
        message: same
          ? `"${m.hostname}" duplicates "${prev.input}" (same host after normalisation).`
          : `"${m.hostname}" and "${prev.input}" are the same host but route to different servers (${prev.targets.join(", ")} vs ${m.targets.join(", ")}).`,
        subject: n.hostname,
      });
      continue;
    }
    byHost.set(n.hostname, { targets: [...m.targets], input: m.hostname });
    let valid = true;
    if (m.targets.length === 0) {
      issues.push({ severity: "error", code: "FORCED_HOST_NO_TARGETS", message: "A forced host needs at least one target server (Velocity rejects empty lists).", subject: n.hostname });
      valid = false;
    }
    const seen = new Set<string>();
    for (const t of m.targets) {
      if (seen.has(t)) issues.push({ severity: "warning", code: "FORCED_HOST_DUPLICATE_TARGET", message: `Target "${t}" is listed twice.`, subject: n.hostname });
      seen.add(t);
      const b = backendByName.get(t);
      if (!b) {
        issues.push({ severity: "error", code: "FORCED_HOST_UNKNOWN_TARGET", message: `Target "${t}" is not a registered backend server.`, subject: n.hostname });
        valid = false;
      } else if (!b.inNetwork) {
        issues.push({ severity: "warning", code: "FORCED_HOST_TARGET_NOT_IN_NETWORK", message: `Target "${t}" is not a member of this network.`, subject: n.hostname });
      } else if (b.state === "stopped" || b.state === "crashed") {
        issues.push({ severity: "warning", code: "FORCED_HOST_TARGET_DOWN", message: `Target "${t}" is ${b.state}; players connecting via this host fall back to the next target or the try list.`, subject: n.hostname });
      }
    }
    if (valid) out.push({ hostname: n.hostname, targets: [...m.targets] });
  }
  return { mappings: out, issues };
}

export interface DnsGuidance {
  hostname: string;
  records: string[];
  notes: string[];
}

const DEFAULT_PORT = 25565;

/**
 * DNS and port guidance for one forced host. BlockForge never creates DNS records.
 * `proxyAddress` is the proxy's public IPv4/IPv6 address or DNS name; `proxyPort` its public port.
 */
export function dnsGuidance(hostname: string, proxyAddress: string | null, proxyPort: number | null): DnsGuidance {
  const records: string[] = [];
  const notes: string[] = [];
  const target = proxyAddress ?? "<proxy public address>";
  const port = proxyPort ?? DEFAULT_PORT;
  if (proxyAddress && IPV4.test(proxyAddress)) records.push(`${hostname}. A ${proxyAddress}`);
  else if (proxyAddress && proxyAddress.includes(":")) records.push(`${hostname}. AAAA ${proxyAddress}`);
  else {
    records.push(`${hostname}. CNAME ${target}.`);
    notes.push("A CNAME cannot be used at the zone apex (example.com itself); use A/AAAA records there.");
  }
  if (port !== DEFAULT_PORT) {
    const srvTarget = `${hostname}`;
    records.push(`_minecraft._tcp.${hostname}. SRV 0 5 ${port} ${srvTarget}.`);
    notes.push(
      `The proxy listens on port ${port}, not 25565: players must enter "${hostname}:${port}", or you add the SRV record above.`,
      "Clients that follow an SRV record send the SRV *target* name in the handshake (Velocity strips its trailing dot), so the SRV target must be this forced host name itself — pointing several SRV records at one shared target breaks forced-host routing.",
    );
  }
  notes.push(
    "Routing depends on the host name the player's client actually connects with; a player who connects via another name or the raw IP is routed by the try list instead.",
    `TCP port ${port} must be reachable from the internet on the proxy (firewall / NAT port forward).`,
    "BlockForge does not create or change DNS records; create them at your DNS provider and allow time for propagation.",
  );
  return { hostname, records, notes };
}
