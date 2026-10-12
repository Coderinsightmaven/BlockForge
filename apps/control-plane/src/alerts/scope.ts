import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { alertIncidents } from "../db/schema/index.js";

/**
 * SQL filter restricting incidents to subjects (nodes / servers) in the given id sets. Subjects of
 * other types (jobs, deleted resources) are only visible with global scope (`"all"`).
 */
export function incidentScopeFilter(nodeIds: "all" | readonly string[], serverIds: "all" | readonly string[]): SQL | undefined {
  if (nodeIds === "all" && serverIds === "all") return undefined;
  const parts: SQL[] = [];
  if (nodeIds !== "all" && nodeIds.length) parts.push(and(eq(alertIncidents.subjectType, "node"), inArray(alertIncidents.subjectId, [...nodeIds])) as SQL);
  if (nodeIds === "all") parts.push(eq(alertIncidents.subjectType, "node"));
  if (serverIds !== "all" && serverIds.length) parts.push(and(eq(alertIncidents.subjectType, "server"), inArray(alertIncidents.subjectId, [...serverIds])) as SQL);
  if (serverIds === "all") parts.push(eq(alertIncidents.subjectType, "server"));
  return parts.length ? (or(...parts) as SQL) : sql`false`;
}
