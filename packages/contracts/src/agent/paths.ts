import { z } from "zod";

/* Kept apart from the command catalogue so that API modules (and the web bundle) can use the path rules
 * without pulling in every agent command schema. */

/**
 * Path relative to a workload's data root. This is a first line of defence only — the agent
 * re-validates and resolves symlinks before touching the filesystem.
 */
export const RelativePath = z
  .string()
  .max(1024)
  .refine((p) => !p.includes("\0"), "NUL byte")
  .refine((p) => !/^([/\\]|[a-zA-Z]:)/.test(p), "must be relative")
  .refine((p) => !p.split(/[/\\]/).includes(".."), "must not contain '..'");

const isRootPath = (p: string) => p.split(/[/\\]/).every((seg) => seg === "" || seg === ".");
/** A relative path that must not resolve to the data root itself ("", ".", "./", …). Used by every mutation. */
export const MutableRelativePath = RelativePath.refine((p) => !isRootPath(p), "must not target the data root");
