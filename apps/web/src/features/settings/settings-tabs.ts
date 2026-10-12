/** Settings page tabs (kept tiny: the route's search validation imports it eagerly). */
export type SettingsTab = "account" | "security" | "ssh" | "api-keys" | "appearance" | "backups";

export const SETTINGS_TABS: readonly SettingsTab[] = [
  "account",
  "security",
  "ssh",
  "api-keys",
  "appearance",
  "backups",
];
