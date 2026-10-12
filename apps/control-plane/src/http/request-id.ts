import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { REQUEST_ID_HEADER } from "@blockforge/contracts";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** Accepts a well-formed upstream `x-request-id` (e.g. from a reverse proxy); otherwise generates one. */
export function genReqId(req: IncomingMessage): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  return value && SAFE_ID.test(value) ? value : randomUUID();
}
