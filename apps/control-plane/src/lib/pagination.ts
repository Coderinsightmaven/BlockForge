import { z } from "zod";
import { badRequest } from "./errors.js";

/** Opaque cursors: base64url(JSON). Decoding is schema-validated so a forged cursor cannot inject anything. */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor<T extends z.ZodType>(schema: T, cursor: string | undefined): z.infer<T> | null {
  if (!cursor) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw badRequest("Invalid cursor");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw badRequest("Invalid cursor");
  return parsed.data;
}

/** Cursor for (timestamp desc, id desc) ordering. */
export const TimeIdCursor = z.object({ t: z.number().int(), id: z.string().max(64) });
export type TimeIdCursor = z.infer<typeof TimeIdCursor>;
