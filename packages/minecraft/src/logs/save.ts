import { consoleMessage, type ConsoleMessageOptions, type ParsedLogLine } from "./parse.js";

/**
 * Console feedback of `save-all` / `save-off` / `save-on`, for consistent backups. Strings come
 * from the server jars' language files — 1.13+ (`en_us.json`, identical in 1.21.11, 26.2 and
 * 26.3): `commands.save.success` "Saved the game", `.saving` "Saving the game (this may take a
 * moment!)", `.disabled` "Automatic saving is now disabled", `.enabled` "Automatic saving is now
 * enabled", `.alreadyOff` "Saving is already turned off", `.alreadyOn` "Saving is already turned
 * on", `.failed` "Unable to save the game (is there enough disk space?)"; ≤ 1.12 (`en_us.lang`):
 * "Saving...", "Saved the world", "Turned off world auto-saving", "Turned on world auto-saving",
 * "Saving failed: %s". Paper, Purpur, Folia, Fabric, Forge and NeoForge use the vanilla commands.
 * 26.3+ prefixes the feedback with `System chat: ` (removed by `consoleMessage`).
 *
 * Strict by default: the line must have a recognised log layout, level INFO, and either no
 * logger segment (vanilla, Fabric, Paper) or the server class that logs command feedback
 * (`MinecraftServer.sendSystemMessage` → Forge/NeoForge `[minecraft/MinecraftServer]`;
 * `minecraft/DedicatedServer` is accepted too). Bare text, mod/plugin loggers (`[EvilMod]`,
 * `[com.evil.Mod]`, Paper's `[Plugin] …`), player chat, `/say` output (`[name] …`) and the op
 * broadcast of a command a player ran (`[name: Saved the game]`) never match. Code running inside
 * the server JVM can of course still log anything through Minecraft's own logger.
 */

/** Loggers allowed for command feedback (see above). */
export const COMMAND_FEEDBACK_LOGGERS: readonly (string | null)[] = [null, "minecraft/MinecraftServer", "minecraft/DedicatedServer"];

const STRICT: ConsoleMessageOptions = { levels: ["info"], loggers: COMMAND_FEEDBACK_LOGGERS };

const SAVING = /^(?:Saving the game \(this may take a moment!\)|Saving\.\.\.)$/;
const SAVED = /^Saved the (?:game|world)$/;
const SAVE_FAILED = /^(?:Unable to save the game \(is there enough disk space\?\)|Saving failed: .*)$/;
const SAVE_OFF = /^(?:Automatic saving is now disabled|Saving is already turned off|Turned off world auto-saving)$/;
const SAVE_ON = /^(?:Automatic saving is now enabled|Saving is already turned on|Turned on world auto-saving)$/;

/** Command-feedback message of a line under the strict rules, or null. */
export function commandFeedbackMessage(line: string | ParsedLogLine): string | null {
  const msg = consoleMessage(line, STRICT);
  return msg === null ? null : msg.trim();
}

function test(re: RegExp, line: string | ParsedLogLine): boolean {
  const msg = commandFeedbackMessage(line);
  return msg !== null && re.test(msg);
}

/** `save-all` started: "Saving the game (this may take a moment!)" (1.13+) / "Saving..." (≤ 1.12). */
export function isSaveProgress(line: string | ParsedLogLine): boolean {
  return test(SAVING, line);
}

/** `save-all [flush]` finished: "Saved the game" (1.13+) / "Saved the world" (≤ 1.12). */
export function isSaveConfirmation(line: string | ParsedLogLine): boolean {
  return test(SAVED, line);
}

/** `save-all` failed (disk full, I/O error). */
export function isSaveFailure(line: string | ParsedLogLine): boolean {
  return test(SAVE_FAILED, line);
}

/** Automatic saving is off after `save-off` (including "already turned off"). */
export function isSaveOffConfirmation(line: string | ParsedLogLine): boolean {
  return test(SAVE_OFF, line);
}

/** Automatic saving is on after `save-on` (including "already turned on"). */
export function isSaveOnConfirmation(line: string | ParsedLogLine): boolean {
  return test(SAVE_ON, line);
}

export type SaveTrackerEvent = "progress" | "saved" | "failed";

/**
 * Follows the console after `save-all flush`: reports `"saved"` only for a confirmation that comes
 * after the progress line of the same save, so a stray "Saved the game" from an earlier save (or
 * an autosave on old versions) is not taken for this one. `"failed"` is reported at any time.
 */
export function createSaveTracker(): { push(line: string | ParsedLogLine): SaveTrackerEvent | null; readonly sawProgress: boolean } {
  let sawProgress = false;
  return {
    push(line) {
      const msg = commandFeedbackMessage(line);
      if (msg === null) return null;
      if (SAVE_FAILED.test(msg)) return "failed";
      if (SAVING.test(msg)) {
        sawProgress = true;
        return "progress";
      }
      if (SAVED.test(msg) && sawProgress) return "saved";
      return null;
    },
    get sawProgress() {
      return sawProgress;
    },
  };
}
