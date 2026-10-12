/**
 * Player identity helpers: UUID normalisation, player-name validation and the offline-mode UUID
 * (`UUID.nameUUIDFromBytes("OfflinePlayer:" + name)`, a version-3 MD5 UUID) that servers with
 * `online-mode=false` assign. Pure: MD5 is implemented here because Web Crypto has none.
 */

const UUID_DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_PLAIN = /^[0-9a-f]{32}$/;

/** Canonical lowercase dashed form of a UUID given dashed or as 32 hex digits; null when invalid. */
export function normalizeUuid(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (UUID_DASHED.test(s)) return s;
  if (UUID_PLAIN.test(s)) return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  return null;
}

export function isUuid(input: string): boolean {
  return normalizeUuid(input) !== null;
}

/** UUID version nibble (4 = Mojang account, 3 = offline-mode name UUID). */
export function uuidVersion(uuid: string): number | null {
  const n = normalizeUuid(uuid);
  return n === null ? null : parseInt(n[14]!, 16);
}

/**
 * Java Edition player names: 1–16 characters of `A-Z a-z 0-9 _` (Mojang allows 3–16 for new
 * accounts; a few legacy accounts are shorter). Anything else — including `@` selectors, spaces
 * and Floodgate/Bedrock prefixes — is refused so a name can never change a command's meaning.
 */
export const PLAYER_NAME_RE = /^[A-Za-z0-9_]{1,16}$/;

export function isValidPlayerName(name: string): boolean {
  return PLAYER_NAME_RE.test(name);
}

export class PlayerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlayerInputError";
  }
}

export function assertPlayerName(name: string): string {
  if (!isValidPlayerName(name)) throw new PlayerInputError("invalid player name (1–16 letters, digits or underscores)");
  return name;
}

export function assertUuid(uuid: string): string {
  const n = normalizeUuid(uuid);
  if (!n) throw new PlayerInputError("invalid UUID");
  return n;
}

// --- MD5 (RFC 1321) -------------------------------------------------------------------------

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

/** MD5 digest of `bytes`. */
export function md5(bytes: Uint8Array): Uint8Array {
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLen / 2 ** 32) >>> 0, true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i]! + M[g]!) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]!) | (F >>> (32 - S[i]!)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true);
  ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true);
  ov.setUint32(12, d0, true);
  return out;
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Java `UUID.nameUUIDFromBytes(bytes)`: MD5 with the version set to 3 and the IETF variant. */
export function nameUuidFromBytes(bytes: Uint8Array): string {
  const h = md5(bytes);
  h[6] = (h[6]! & 0x0f) | 0x30;
  h[8] = (h[8]! & 0x3f) | 0x80;
  return normalizeUuid(hex(h))!;
}

/**
 * UUID an offline-mode (`online-mode=false`) server assigns to `name`. Case-sensitive, exactly
 * like the server: "Notch" and "notch" are different offline players.
 */
export function offlinePlayerUuid(name: string): string {
  return nameUuidFromBytes(new TextEncoder().encode(`OfflinePlayer:${name}`));
}
