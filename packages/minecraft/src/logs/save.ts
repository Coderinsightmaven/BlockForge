import { consoleMessage, type ParsedLogLine } from "./parse.js";

/**
 * Console feedback of `save-all` / `save-off` / `save-on`, for consistent backups. Strings come
 * from the server jars' language files — 1.13+ (`en_us.json`, unchanged through 26.3):
 * `commands.save.success` "Saved the game", `.saving` "Saving the game (this may take a
 * moment!)", `.disabled` "Automatic saving is now disabled", `.enabled` "Automatic saving is now
 * enabled", `.alreadyOff` "Saving is already turned off", `.alreadyOn` "Saving is already turned
 * on", `.failed` "Unable to save the game (is there enough disk space?)"; ≤ 1.12 (`en_us.lang`):
 * "Saved the world", "Turned off world auto-saving", "Turned on world auto-saving", "Saving
 * failed: %s". Paper, Purpur, Folia, Fabric, Forge and NeoForge use the vanilla commands. 26.3+
 * prefixes the feedback with `System chat: ` (handled by `consoleMessage`).
 *
 * Patterns are anchored on the server's own message, so player chat (`<name> Saved the game`),
 * `/say` output (`[name] …`) and the op broadcast of a command a player ran
 * (`[name: Saved the game]`) never match.
 */

const SAVED = /^Saved the (?:game|world)$/;
const SAVE_FAILED = /^(?:Unable to save the game \(is there enough disk space\?\)|Saving failed: .*)$/;
const SAVE_OFF = /^(?:Automatic saving is now disabled|Saving is already turned off|Turned off world auto-saving)$/;
const SAVE_ON = /^(?:Automatic saving is now enabled|Saving is already turned on|Turned on world auto-saving)$/;

function test(re: RegExp, line: string | ParsedLogLine): boolean {
  const msg = consoleMessage(line);
  return msg !== null && re.test(msg.trim());
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
