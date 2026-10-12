import { ExtensionUploadSettings } from "@blockforge/contracts";
import { z } from "zod";
import { apiClient } from "./client";

/* Admin policy for plugin/mod uploads (Settings → Plugin uploads; lazily loaded card). */

type In<T extends z.ZodType> = z.input<T>;

const ExtensionUploadSettingsView = z.object({
  key: z.literal("extensions.uploads"),
  value: ExtensionUploadSettings,
});

/** Admin policy for `/extensions/uploads` (generic settings wrapper, settings.manage). */
export const extensionUploadSettingsApi = {
  get: (signal?: AbortSignal) =>
    apiClient.get("/settings/extensions.uploads", { schema: ExtensionUploadSettingsView, signal }),
  put: (value: In<typeof ExtensionUploadSettings>) =>
    apiClient.put("/settings/extensions.uploads", { body: { value }, schema: ExtensionUploadSettingsView }),
};
