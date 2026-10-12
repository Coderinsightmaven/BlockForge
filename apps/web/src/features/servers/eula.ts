import { stripFormatting } from "@blockforge/minecraft";

/*
 * Minecraft refuses to start until `eula.txt` says `eula=true` and prints
 * "You need to agree to the EULA in order to run the server". Like Pterodactyl's EULA modal, the
 * server page offers to accept it (write eula.txt, then start).
 */

export const EULA_FILE = "eula.txt";
export const EULA_URL = "https://aka.ms/MinecraftEULA";

const PROMPT = /you need to agree to the eula/i;

/** Whether a console line is Minecraft's EULA refusal (formatting codes ignored). */
export function isEulaPrompt(line: string): boolean {
  return PROMPT.test(stripFormatting(line));
}

const EULA_LINE = /^[ \t]*eula[ \t]*[=:][ \t]*(.*?)[ \t]*$/im;

/**
 * Parse eula.txt (Java properties). `true` only for an explicit `eula=true` (case-insensitive, as
 * Minecraft reads it); a missing line or any other value means the server will refuse to start.
 */
export function eulaAccepted(content: string): boolean {
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trimStart();
    if (line.startsWith("#") || line.startsWith("!")) continue;
    const m = EULA_LINE.exec(line);
    if (m) return m[1]!.toLowerCase() === "true";
  }
  return false;
}

/** eula.txt content with `eula=true`, keeping every other line (comments, unrelated keys). */
export function acceptEulaContent(content: string | null, now: Date = new Date()): string {
  const stamp = `#Accepted through BlockForge on ${now.toISOString()} (${EULA_URL})`;
  if (!content || !content.trim()) return `${stamp}\neula=true\n`;
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  let replaced = false;
  const out = lines.map((raw) => {
    const line = raw.trimStart();
    if (replaced || line.startsWith("#") || line.startsWith("!")) return raw;
    if (EULA_LINE.test(line)) {
      replaced = true;
      return "eula=true";
    }
    return raw;
  });
  if (!replaced) {
    while (out.length && out[out.length - 1] === "") out.pop();
    out.push("eula=true", "");
  }
  return out.join(eol);
}
