import { getProperty, parseProperties } from "./properties/document.js";

/**
 * `eula.txt`. The vanilla server writes (26.3, observed 2026-10-12):
 *   #By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).
 *   #Mon Oct 12 03:32:36 UTC 2026
 *   eula=false
 * and reads it with `Boolean.parseBoolean` (case-insensitive "true").
 * Only generate `eula=true` after the user explicitly accepted the EULA
 * (CreateServerRequest.acceptEula), and record who/when in the audit log.
 */
export const EULA_URL = "https://aka.ms/MinecraftEULA";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `java.util.Date#toString()` in UTC, as written by the server ("Mon Oct 12 03:32:36 UTC 2026"). */
export function javaDateString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`;
}

export function generateEula(acceptedAt: Date, opts: { acceptedBy?: string } = {}): string {
  if (Number.isNaN(acceptedAt.getTime())) throw new RangeError("invalid acceptance date");
  const by = opts.acceptedBy ? ` by ${opts.acceptedBy.replace(/[^\w.@ -]/g, "_").slice(0, 80)}` : "";
  return [
    `#By changing the setting below to TRUE you are indicating your agreement to our EULA (${EULA_URL}).`,
    `#${javaDateString(acceptedAt)}`,
    `#Accepted through BlockForge${by} at ${acceptedAt.toISOString()}`,
    "eula=true",
    "",
  ].join("\n");
}

export function isEulaAccepted(text: string): boolean {
  // Boolean.parseBoolean: exact, case-insensitive "true" (trailing spaces make it false).
  return (getProperty(parseProperties(text), "eula") ?? "").toLowerCase() === "true";
}
