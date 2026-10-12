/**
 * Tokenizer for Minecraft `§` formatting codes and ANSI SGR escapes. Produces plain-text segments
 * with style information — never HTML. Log content is untrusted: every escape sequence and
 * control character other than TAB is removed from the text.
 *
 * `§` codes: 0–9a–f colours (also reset decorations), k obfuscated, l bold, m strikethrough,
 * n underline, o italic, r reset, and the BungeeCord hex form `§x§R§R§G§G§B§B`.
 * ANSI: SGR (`ESC[…m`) 0/1/3/4/9/22/23/24/29/30–37/39/90–97/38;5;n/38;2;r;g;b; every other CSI,
 * OSC (`ESC]…BEL` / `ESC]…ESC\`) and lone ESC sequences are stripped.
 */

export const MINECRAFT_COLORS = [
  "black",
  "dark_blue",
  "dark_green",
  "dark_aqua",
  "dark_red",
  "dark_purple",
  "gold",
  "gray",
  "dark_gray",
  "blue",
  "green",
  "aqua",
  "red",
  "light_purple",
  "yellow",
  "white",
] as const;
export type MinecraftColor = (typeof MINECRAFT_COLORS)[number];

export type TextColor =
  | { kind: "minecraft"; name: MinecraftColor }
  /** 0–15 standard/bright terminal colours, 16–255 xterm palette. */
  | { kind: "ansi"; index: number }
  | { kind: "rgb"; hex: string };

export interface TextStyle {
  color: TextColor | null;
  bold: boolean;
  italic: boolean;
  underlined: boolean;
  strikethrough: boolean;
  obfuscated: boolean;
}

export interface FormattedSegment {
  text: string;
  style: TextStyle;
}

const PLAIN: TextStyle = { color: null, bold: false, italic: false, underlined: false, strikethrough: false, obfuscated: false };

function sameStyle(a: TextStyle, b: TextStyle): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underlined === b.underlined &&
    a.strikethrough === b.strikethrough &&
    a.obfuscated === b.obfuscated &&
    JSON.stringify(a.color) === JSON.stringify(b.color)
  );
}

function applySgr(params: number[], style: TextStyle): TextStyle {
  let s = { ...style };
  if (params.length === 0) params = [0];
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) s = { ...PLAIN };
    else if (p === 1) s.bold = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underlined = true;
    else if (p === 5 || p === 6) s.obfuscated = false; // blink: ignored
    else if (p === 9) s.strikethrough = true;
    else if (p === 22) s.bold = false;
    else if (p === 23) s.italic = false;
    else if (p === 24) s.underlined = false;
    else if (p === 29) s.strikethrough = false;
    else if (p >= 30 && p <= 37) s.color = { kind: "ansi", index: p - 30 };
    else if (p >= 90 && p <= 97) s.color = { kind: "ansi", index: p - 90 + 8 };
    else if (p === 39) s.color = null;
    else if (p === 38 || p === 48) {
      const mode = params[i + 1];
      if (mode === 5) {
        const idx = params[i + 2];
        if (p === 38 && idx !== undefined && idx >= 0 && idx <= 255) s.color = { kind: "ansi", index: idx };
        i += 2;
      } else if (mode === 2) {
        const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]];
        if (p === 38 && [r, g, b].every((v) => v !== undefined && v >= 0 && v <= 255)) {
          s.color = { kind: "rgb", hex: `#${[r, g, b].map((v) => v!.toString(16).padStart(2, "0")).join("")}` };
        }
        i += 4;
      }
    }
    // 40–47, 100–107, 49 (backgrounds) and unknown codes are ignored.
  }
  return s;
}

function sectionCode(c: string, style: TextStyle): TextStyle | null {
  const lc = c.toLowerCase();
  const colorIdx = "0123456789abcdef".indexOf(lc);
  if (colorIdx >= 0) return { ...PLAIN, color: { kind: "minecraft", name: MINECRAFT_COLORS[colorIdx]! } };
  switch (lc) {
    case "k":
      return { ...style, obfuscated: true };
    case "l":
      return { ...style, bold: true };
    case "m":
      return { ...style, strikethrough: true };
    case "n":
      return { ...style, underlined: true };
    case "o":
      return { ...style, italic: true };
    case "r":
      return { ...PLAIN };
    default:
      return null;
  }
}

export function tokenizeFormatting(input: string): FormattedSegment[] {
  const out: FormattedSegment[] = [];
  let style: TextStyle = { ...PLAIN };
  let buf = "";
  const flush = () => {
    if (buf === "") return;
    const last = out[out.length - 1];
    if (last && sameStyle(last.style, style)) last.text += buf;
    else out.push({ text: buf, style: { ...style, color: style.color ? { ...style.color } : null } });
    buf = "";
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    const code = c.charCodeAt(0);
    if (c === "\u001b") {
      const n = input[i + 1];
      if (n === "[") {
        // CSI: parameters 0x30–0x3F, intermediates 0x20–0x2F, final byte 0x40–0x7E.
        let j = i + 2;
        while (j < input.length && input.charCodeAt(j) >= 0x30 && input.charCodeAt(j) <= 0x3f) j++;
        while (j < input.length && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x2f) j++;
        const final = input[j];
        if (final === "m") {
          flush();
          const raw = input.slice(i + 2, j);
          const params = raw === "" ? [] : raw.split(/[;:]/).map((x) => (x === "" ? 0 : Number(x)));
          if (params.every((x) => Number.isInteger(x))) style = applySgr(params, style);
        }
        i = final === undefined ? input.length : j;
        continue;
      }
      if (n === "]") {
        let j = i + 2;
        while (j < input.length && input[j] !== "\u0007" && !(input[j] === "\u001b" && input[j + 1] === "\\")) j++;
        i = input[j] === "\u001b" ? j + 1 : j;
        continue;
      }
      i += n === undefined ? 0 : 1; // two-byte escape (ESC c, ESC 7, …)
      continue;
    }
    if (c === "§") {
      const n = input[i + 1];
      if (n === undefined) break;
      if ((n === "x" || n === "X") && /^(?:§[0-9a-fA-F]){6}$/.test(input.slice(i + 2, i + 14))) {
        flush();
        const hex = input.slice(i + 2, i + 14).replace(/§/g, "").toLowerCase();
        style = { ...PLAIN, color: { kind: "rgb", hex: `#${hex}` } };
        i += 13;
        continue;
      }
      const next = sectionCode(n, style);
      flush();
      if (next) style = next;
      i += 1;
      continue;
    }
    if ((code < 0x20 && c !== "\t") || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    buf += c;
  }
  flush();
  return out;
}

/** Plain text without formatting codes or control characters. */
export function stripFormatting(input: string): string {
  return tokenizeFormatting(input)
    .map((s) => s.text)
    .join("");
}
