import type { z } from "zod";
import { badRequest } from "../lib/errors.js";
import { zodDetails } from "./errors.js";

/** Parses untrusted input with a zod schema; failures become 400 VALIDATION_FAILED with issue paths. */
export function parse<T extends z.ZodType>(schema: T, value: unknown, what = "Request"): z.infer<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw badRequest(`${what} validation failed`, zodDetails(result.error));
  return result.data;
}
