import {
  DatabaseHost,
  DatabaseHostTestResult,
  ServerDatabase,
  ServerDatabasePassword,
} from "@blockforge/contracts";
import type {
  CreateDatabaseHostRequest,
  CreateServerDatabaseRequest,
  TestDatabaseHostRequest,
  UpdateDatabaseHostRequest,
} from "@blockforge/contracts";
import { z } from "zod";
import { apiClient } from "./client";

/*
 * MySQL/MariaDB database routes (docs/architecture/api.md: Databases). Imported only by the lazily
 * loaded Databases tab and the Database hosts page. Responses are validated against the strict
 * contract schemas, so a host or database response that carried a password would be rejected.
 */

type In<T extends z.ZodType> = z.input<T>;
const enc = encodeURIComponent;

export const serverDatabasesApi = {
  list: (serverId: string, signal?: AbortSignal) =>
    apiClient.get(`/servers/${enc(serverId)}/databases`, { schema: z.array(ServerDatabase), signal }),
  create: (serverId: string, body: CreateServerDatabaseRequest) =>
    apiClient.post(`/servers/${enc(serverId)}/databases`, { body, schema: ServerDatabase }),
  /**
   * The database password (`Cache-Control: no-store`, audited). Call it directly on a user's click
   * and keep the result in component state only — never through a query or mutation cache.
   */
  password: (serverId: string, databaseId: string, signal?: AbortSignal) =>
    apiClient.get(`/servers/${enc(serverId)}/databases/${enc(databaseId)}/password`, {
      schema: ServerDatabasePassword,
      signal,
    }),
  rotatePassword: (serverId: string, databaseId: string) =>
    apiClient.post(`/servers/${enc(serverId)}/databases/${enc(databaseId)}/rotate-password`, {
      schema: ServerDatabase,
    }),
  remove: (serverId: string, databaseId: string) =>
    apiClient.delete<void>(`/servers/${enc(serverId)}/databases/${enc(databaseId)}`),
};

export const databaseHostsApi = {
  list: (signal?: AbortSignal) => apiClient.get("/database-hosts", { schema: z.array(DatabaseHost), signal }),
  /** The body carries the admin password: call through a `sensitive` mutation only. */
  create: (body: In<typeof CreateDatabaseHostRequest>) =>
    apiClient.post("/database-hosts", { body, schema: DatabaseHost }),
  /** May carry the admin password (omitted = keep the stored one): `sensitive` mutation only. */
  update: (id: string, body: In<typeof UpdateDatabaseHostRequest>) =>
    apiClient.patch(`/database-hosts/${enc(id)}`, { body, schema: DatabaseHost }),
  remove: (id: string) => apiClient.delete<void>(`/database-hosts/${enc(id)}`),
  /** Tests the saved host. */
  test: (id: string) => apiClient.post(`/database-hosts/${enc(id)}/test`, { schema: DatabaseHostTestResult }),
  /** Tests unsaved form values (`hostId` instead of `password` reuses the stored password). */
  testSettings: (body: In<typeof TestDatabaseHostRequest>) =>
    apiClient.post("/database-hosts/test", { body, schema: DatabaseHostTestResult }),
};
