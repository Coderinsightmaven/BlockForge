import type { Template } from "@blockforge/contracts";

/**
 * Exports a template as a PTDL_v2 egg, shaped like Pterodactyl's `EggExporterService`
 * (`config.*` as JSON-encoded strings, variables with `field_type: "text"`). Variables are
 * ordered by `sortOrder`; no `sort` field is written because Pterodactyl's importer
 * force-creates rows from every variable key.
 */
export function exportEgg(
  template: Pick<
    Template,
    "name" | "author" | "description" | "features" | "dockerImages" | "fileDenylist" | "startup" | "configFiles" | "startupDone" | "stop" | "install" | "variables"
  >,
  opts: { exportedAt?: Date } = {},
): Record<string, unknown> {
  const files: Record<string, { parser: string; find: Record<string, unknown> }> = {};
  for (const f of template.configFiles) files[f.path] = { parser: f.parser, find: f.find };
  const done = template.startupDone.length === 1 ? template.startupDone[0]! : template.startupDone;
  const stop =
    template.stop.type === "command" ? template.stop.command : template.stop.signal === "SIGINT" ? "^C" : `^${template.stop.signal}`;
  const dockerImages: Record<string, string> = {};
  for (const im of template.dockerImages) dockerImages[dockerImages[im.label] === undefined ? im.label : `${im.label} (${im.image})`] = im.image;
  const pretty = (v: unknown) => JSON.stringify(v, null, 4);
  return {
    _comment: "DO NOT EDIT: FILE GENERATED AUTOMATICALLY BY BLOCKFORGE (PTERODACTYL-COMPATIBLE PTDL_v2 EGG)",
    meta: { version: "PTDL_v2", update_url: null },
    exported_at: (opts.exportedAt ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    name: template.name,
    author: template.author ?? "",
    description: template.description,
    features: template.features.length > 0 ? [...template.features] : null,
    docker_images: dockerImages,
    file_denylist: [...template.fileDenylist],
    startup: template.startup,
    config: {
      files: Object.keys(files).length > 0 ? pretty(files) : "{}",
      startup: pretty({ done }),
      logs: "{}",
      stop,
    },
    scripts: {
      installation: template.install
        ? { script: template.install.script, container: template.install.image, entrypoint: template.install.entrypoint }
        : { script: "", container: "", entrypoint: "" },
    },
    variables: [...template.variables]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((v) => ({
        name: v.name,
        description: v.description,
        env_variable: v.envName,
        default_value: v.defaultValue,
        user_viewable: v.userViewable,
        user_editable: v.userEditable,
        rules: v.rules,
        field_type: "text",
      })),
  };
}
