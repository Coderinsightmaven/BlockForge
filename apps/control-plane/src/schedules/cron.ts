import type { ScheduleCron } from "@blockforge/contracts";
import { Cron } from "croner";

export function cronPattern(c: ScheduleCron): string {
  return `${c.minute} ${c.hour} ${c.dayOfMonth} ${c.month} ${c.dayOfWeek}`;
}

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Compiles the cron trigger; throws with a readable message when the pattern or zone is invalid. */
export function compileCron(c: ScheduleCron, timezone: string): Cron {
  if (!validTimezone(timezone)) throw new Error(`unknown time zone ${timezone}`);
  return new Cron(cronPattern(c), { timezone, paused: true });
}

/** The next `count` run times strictly after `from` (in the trigger's time zone). */
export function nextRuns(c: ScheduleCron, timezone: string, count: number, from: Date): Date[] {
  return compileCron(c, timezone).nextRuns(count, from);
}

export function nextRun(c: ScheduleCron, timezone: string, from: Date): Date | null {
  return compileCron(c, timezone).nextRun(from);
}

/** Cron validation for request bodies: null when valid, else the error message. */
export function cronError(c: ScheduleCron, timezone: string): string | null {
  try {
    compileCron(c, timezone).nextRun(new Date());
    return null;
  } catch (err) {
    return (err as Error).message.replace(/^Cron\w*: /, "");
  }
}
