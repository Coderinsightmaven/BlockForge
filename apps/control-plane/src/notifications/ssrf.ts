import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

/** Expands an IPv6 address into 8 16-bit groups (handles `::` and embedded IPv4). */
export function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    if (isIP(maybeV4) !== 4) return null;
    const n = v4ToInt(maybeV4);
    tail = [n >>> 16, n & 0xffff];
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(":").map((h) => parseInt(h, 16)) : []);
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const fill = 8 - head.length - rest.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...rest];
  if (tail.length) groups.splice(6, 2, ...tail);
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function embeddedV4(g: number[]): string {
  return [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff].join(".");
}

function v6Blocked(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true;
  const [a, b] = [g[0]!, g[1]!];
  const allZero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (allZero(0, 8)) return true; // ::
  if (allZero(0, 7) && g[7] === 1) return true; // ::1
  if (allZero(0, 5) && g[5] === 0xffff) return v4Blocked(embeddedV4(g)); // ::ffff:a.b.c.d (IPv4-mapped)
  if (allZero(0, 6)) return v4Blocked(embeddedV4(g)); // ::a.b.c.d (IPv4-compatible, deprecated)
  if (a === 0x64 && b === 0xff9b && allZero(2, 6)) return v4Blocked(embeddedV4(g)); // NAT64 64:ff9b::/96
  if (a === 0x2002) return v4Blocked([b >> 8, b & 0xff, g[2]! >> 8, g[2]! & 0xff].join(".")); // 6to4
  if (a === 0x100 && allZero(1, 4)) return true; // discard 100::/64
  if ((a & 0xfe00) === 0xfc00) return true; // ULA fc00::/7 (incl. fd00:ec2::254 metadata)
  if ((a & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((a & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return true; // multicast
  if (a === 0x2001 && b === 0x0db8) return true; // documentation
  if (a === 0x2001 && b < 0x200) return true; // 2001::/23 IETF special purpose (Teredo, ORCHID…)
  return false;
}

/** True for loopback, private, link-local, CGNAT, metadata, multicast, reserved and documentation ranges. */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return v4Blocked(ip);
  if (v === 6) return v6Blocked(ip);
  return true;
}

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>;

export const systemLookup: LookupFn = (host) => dnsLookup(host, { all: true, verbatim: true });

export interface ValidatedTarget {
  url: URL;
  /** The address to connect to (pinned, so DNS cannot change between check and connect). */
  address: string;
  family: 4 | 6;
}

/**
 * Validates an outbound webhook URL: HTTPS only, no credentials, and every resolved address must be
 * public unless the hostname is on the admin allowlist. Returns the pinned address to connect to.
 */
export async function validateOutboundUrl(
  raw: string | URL,
  opts: { allowlist?: readonly string[]; lookup?: LookupFn } = {},
): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    throw new SsrfError("invalid URL");
  }
  if (url.protocol !== "https:") throw new SsrfError("only https:// URLs are allowed");
  if (url.username || url.password) throw new SsrfError("URLs with credentials are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new SsrfError("missing host");
  const allowlisted = (opts.allowlist ?? []).map((h) => h.toLowerCase()).includes(host);
  let addresses: { address: string; family: number }[];
  if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
  else {
    try {
      addresses = await (opts.lookup ?? systemLookup)(host);
    } catch {
      throw new SsrfError(`could not resolve ${host}`);
    }
  }
  if (addresses.length === 0) throw new SsrfError(`could not resolve ${host}`);
  if (!allowlisted) {
    const blocked = addresses.find((a) => isBlockedAddress(a.address));
    if (blocked) throw new SsrfError(`${host} resolves to a non-public address (${blocked.address})`);
  }
  const first = addresses[0]!;
  return { url, address: first.address, family: first.family === 6 ? 6 : 4 };
}
