/*
 * Console command history (↑/↓ recall). Commands can contain secrets (`/login <password>`, RCON
 * passwords, tokens), so they live only in memory for the page's lifetime — never in Web Storage —
 * and are wiped on logout and when the session ends, so the next account on the same tab cannot
 * recall them.
 */

export const COMMAND_HISTORY_MAX = 100;
const LEGACY_PREFIX = "blockforge.console-history.";

const histories = new Map<string, string[]>();

export function getCommandHistory(serverId: string): readonly string[] {
  return histories.get(serverId) ?? [];
}

export function addCommand(serverId: string, command: string): readonly string[] {
  const next = [...getCommandHistory(serverId).filter((c) => c !== command), command].slice(
    -COMMAND_HISTORY_MAX,
  );
  histories.set(serverId, next);
  return next;
}

/** Forget every server's history and remove copies an older build kept in sessionStorage. */
export function clearConsoleHistories(): void {
  histories.clear();
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(LEGACY_PREFIX)) sessionStorage.removeItem(k);
    }
  } catch {
    /* storage unavailable */
  }
}
