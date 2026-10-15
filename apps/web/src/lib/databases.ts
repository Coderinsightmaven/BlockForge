import { DatabaseErrorDetails } from "@blockforge/contracts";
import type { ServerDatabase, ServerDatabaseStatus } from "@blockforge/contracts";
import { toast } from "sonner";
import { describeError, isApiError } from "./api/errors";
import { toastError } from "./mutations";

/*
 * Pure helpers shared by the server Databases tab and the Database hosts page (tested).
 */

/** `host:port` for URLs and display; IPv6 literals are bracketed (`[2001:db8::1]:3306`). */
export function hostPort(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** `jdbc:mysql://host:port/database` (no credentials). */
export function jdbcUrl(db: Pick<ServerDatabase, "host" | "port" | "database">): string {
  return `jdbc:mysql://${hostPort(db.host, db.port)}/${db.database}`;
}

/** `mysql://user:password@host:port/database` with URL-encoded credentials. Only build it while revealed. */
export function connectionString(
  db: Pick<ServerDatabase, "host" | "port" | "database" | "username">,
  password: string,
): string {
  return `mysql://${encodeURIComponent(db.username)}:${encodeURIComponent(password)}@${hostPort(db.host, db.port)}/${db.database}`;
}

/** The `details.reason` of a database API error (`DatabaseErrorDetails`), when present. */
export function databaseErrorDetails(err: unknown): DatabaseErrorDetails | null {
  if (!isApiError(err)) return null;
  const parsed = DatabaseErrorDetails.safeParse(err.details);
  return parsed.success ? parsed.data : null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Appended to `host_error` when the host stopped answering before the change could be confirmed. */
export const UNKNOWN_OUTCOME_MESSAGE =
  "The host stopped answering mid-change; BlockForge will reconcile it (see the database's status).";

// ---------------------------------------------------------------------------------------------
// Database status (`ServerDatabase.status`): what each state allows

/** Only these reveal the password: while rotating/deleting the stored password is still the current one. */
export function statusAllowsPassword(status: ServerDatabaseStatus): boolean {
  return status === "ready" || status === "rotating" || status === "deleting";
}

/** Rotating fixes `password_unknown`; nothing else may run while an operation talks to the host. */
export function statusAllowsRotate(status: ServerDatabaseStatus): boolean {
  return status === "ready" || status === "password_unknown";
}

/** Deleting retries a pending cleanup too; only an operation in progress blocks it. */
export function statusAllowsDelete(status: ServerDatabaseStatus): boolean {
  return status !== "creating" && status !== "deleting" && status !== "rotating";
}

/** An operation is talking to the host right now. */
export function statusInProgress(status: ServerDatabaseStatus): boolean {
  return status === "creating" || status === "rotating" || status === "deleting";
}

/** Why the password cannot be shown in this status (null when it can). */
export function passwordBlockedReason(status: ServerDatabaseStatus): string | null {
  switch (status) {
    case "creating":
      return "The database is still being created; its password is available once it is ready.";
    case "cleanup_pending":
      return "This database awaits cleanup after a failed operation and has no usable password.";
    case "password_unknown":
      return "The last password rotation could not be confirmed, so the stored password may be wrong. Rotate the password again.";
    default:
      return null;
  }
}

/** Why rotating is not possible in this status (null when it is). */
export function rotateBlockedReason(status: ServerDatabaseStatus): string | null {
  switch (status) {
    case "creating":
      return "Wait until the database has been created.";
    case "rotating":
      return "A password rotation is already in progress.";
    case "deleting":
      return "The database is being deleted.";
    case "cleanup_pending":
      return "The database awaits cleanup; delete it to retry the cleanup now.";
    default:
      return null;
  }
}

/** Why deleting is not possible in this status (null when it is). */
export function deleteBlockedReason(status: ServerDatabaseStatus): string | null {
  switch (status) {
    case "creating":
      return "Wait until the database has been created.";
    case "rotating":
      return "Wait for the password rotation to finish.";
    case "deleting":
      return "The database is already being deleted.";
    default:
      return null;
  }
}

/**
 * A clear message for a database error reason; falls back to the API's own message (with its code
 * and request id) for anything else.
 */
export function databaseErrorMessage(err: unknown): string {
  const d = databaseErrorDetails(err);
  switch (d?.reason) {
    case "disabled":
      return "Databases are disabled for this server (its database limit is 0). An administrator can raise the limit.";
    case "limit_reached":
      return d.limit !== undefined
        ? `This server has reached its limit of ${plural(d.limit, "database")}. Delete one first, or ask an administrator to raise the limit.`
        : "This server has reached its database limit. Delete one first, or ask an administrator to raise the limit.";
    case "name_taken":
      return "This server already has a database with this name. Choose another name.";
    case "host_full":
      return "The selected database host has no room for another database. Pick another host, or Automatic.";
    case "no_host":
      return "No database host has room for another database. Ask an administrator to add a database host or raise a host's limit.";
    case "host_error":
      return (
        `The database host refused the request or could not be reached${d.code ? ` (error ${d.code})` : ""}. Try again later, or ask an administrator to check the host.` +
        (d.unknownOutcome ? ` ${UNKNOWN_OUTCOME_MESSAGE}` : "")
      );
    case "busy":
      return "Another operation on this database is still in progress — try again in a moment.";
    case "not_ready":
      return "This database is still being created or awaits cleanup.";
    case "password_unknown":
      return "The last password rotation could not be confirmed — rotate the password again.";
    case "has_databases":
      return d.count !== undefined
        ? `This host still holds ${plural(d.count, "database")}. Delete them from their servers before deleting the host.`
        : "This host still holds databases. Delete them from their servers before deleting the host.";
    default:
      return describeError(err).title;
  }
}

/** Error toast: the mapped reason when the API sent one, else the usual message + code + request id. */
export function toastDatabaseError(err: unknown, title: string): void {
  if (!databaseErrorDetails(err)) return toastError(err, title);
  const d = describeError(err);
  toast.error(title, { description: [databaseErrorMessage(err), d.detail].filter(Boolean).join(" — ") });
}
