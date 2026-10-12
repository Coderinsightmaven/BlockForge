import type { ScheduleCron } from "@blockforge/contracts";
import { formatTimestamp } from "./format";

/*
 * Cron display helpers for the Schedules tab. The control plane is the authority on cron syntax and
 * next run times (`POST /schedules/preview`); this only renders common expressions in words.
 */

export const CRON_FIELDS: Array<{ key: keyof ScheduleCron; label: string; hint: string }> = [
  { key: "minute", label: "Minute", hint: "0–59" },
  { key: "hour", label: "Hour", hint: "0–23" },
  { key: "dayOfMonth", label: "Day of month", hint: "1–31" },
  { key: "month", label: "Month", hint: "1–12 or JAN–DEC" },
  { key: "dayOfWeek", label: "Day of week", hint: "0–6 (Sun=0) or SUN–SAT" },
];

const cron = (minute: string, hour: string, dayOfMonth: string, month: string, dayOfWeek: string) => ({
  minute,
  hour,
  dayOfMonth,
  month,
  dayOfWeek,
});

export const CRON_PRESETS: Array<{ id: string; label: string; cron: ScheduleCron }> = [
  { id: "every-15", label: "Every 15 minutes", cron: cron("*/15", "*", "*", "*", "*") },
  { id: "hourly", label: "Hourly", cron: cron("0", "*", "*", "*", "*") },
  { id: "daily", label: "Daily at 04:00", cron: cron("0", "4", "*", "*", "*") },
  { id: "weekly", label: "Weekly (Sunday 04:00)", cron: cron("0", "4", "*", "*", "0") },
];

export function cronString(c: ScheduleCron): string {
  return [c.minute, c.hour, c.dayOfMonth, c.month, c.dayOfWeek].join(" ");
}

export function presetFor(c: ScheduleCron): string | null {
  const s = cronString(c);
  return CRON_PRESETS.find((p) => cronString(p.cron) === s)?.id ?? null;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_ABBR = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const isNum = (s: string, max: number) => /^\d{1,2}$/.test(s) && Number(s) <= max;
const pad = (n: string) => n.padStart(2, "0");

function dayIndex(token: string): number | null {
  const t = token.toUpperCase();
  if (/^\d$/.test(t)) {
    const n = Number(t);
    return n === 7 ? 0 : n <= 6 ? n : null; // 7 is Sunday too
  }
  const i = DAY_ABBR.indexOf(t);
  return i === -1 ? null : i;
}

/** Day-of-week field as words ("Monday and Friday", "weekday (Mon–Fri)"), or null when not simple. */
function describeDays(field: string): string | null {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = part.split("-");
    if (range.length === 2) {
      const a = dayIndex(range[0]!);
      const b = dayIndex(range[1]!);
      if (a === null || b === null || a > b) return null;
      for (let d = a; d <= b; d++) days.add(d);
    } else if (range.length === 1) {
      const d = dayIndex(part);
      if (d === null) return null;
      days.add(d);
    } else return null;
  }
  const sorted = [...days].sort();
  if (sorted.join() === "1,2,3,4,5") return "weekday (Mon–Fri)";
  const names = sorted.map((d) => DAY_NAMES[d]!);
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
}

/** Common expressions in words; null for anything else (show the raw fields then). */
export function describeCron(c: ScheduleCron): string | null {
  const { minute: m, hour: h, dayOfMonth: dom, month: mon, dayOfWeek: dow } = c;
  const anyDate = dom === "*" && mon === "*";
  if (m === "*" && h === "*" && anyDate && dow === "*") return "Every minute";
  const everyMin = /^\*\/(\d{1,2})$/.exec(m);
  if (everyMin && h === "*" && anyDate && dow === "*") return `Every ${everyMin[1]} minutes`;
  if (!isNum(m, 59)) return null;
  if (h === "*" && anyDate && dow === "*") return `Every hour at :${pad(m)}`;
  const everyHour = /^\*\/(\d{1,2})$/.exec(h);
  if (everyHour && anyDate && dow === "*") return `Every ${everyHour[1]} hours at :${pad(m)}`;
  if (!isNum(h, 23)) return null;
  const at = `${pad(h)}:${pad(m)}`;
  if (anyDate && dow === "*") return `Every day at ${at}`;
  if (anyDate) {
    const days = describeDays(dow);
    return days ? `Every ${days} at ${at}` : null;
  }
  if (isNum(dom, 31) && mon === "*" && dow === "*") return `On day ${Number(dom)} of every month at ${at}`;
  return null;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** IANA zones the browser knows (for the time-zone picker); empty when unsupported. */
export function timeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

/** "2026-10-12 04:00 CEST" in `tz` (falls back to the browser's zone for an unknown one). */
export function formatInZone(ts: number, tz: string | undefined): string {
  return formatTimestamp(ts, { timeZone: tz && isValidTimeZone(tz) ? tz : undefined, seconds: false });
}
