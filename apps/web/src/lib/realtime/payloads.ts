import {
  AlertIncident,
  Backup,
  Job,
  JobLogLine,
  Node,
  NodeMetricSample,
  OverviewSummary,
  Schedule,
  Server,
  WorkloadMetricSample,
} from "@blockforge/contracts";
import type { RealtimeEventType } from "@blockforge/contracts";
import { z } from "zod";
import { ConsoleLinesEvent } from "./protocol";

/*
 * Realtime payload schemas for the always-loaded app (shell, server page, node page). They are the
 * contract's `REALTIME_EVENT_PAYLOADS` entries, rebuilt here from the same contract schemas so the
 * first-load bundle does not pull in every event's module (e.g. the Plugins & mods / Players
 * contracts). A test pins each entry to the contract's (identical JSON Schema). Lazily loaded tabs
 * may use `REALTIME_EVENT_PAYLOADS` directly.
 */
export const SHELL_EVENT_PAYLOADS = {
  "overview.updated": OverviewSummary,
  "node.updated": Node,
  "node.metrics": z.object({ nodeId: z.uuid(), sample: NodeMetricSample }),
  "server.updated": Server.omit({ myPermissions: true, sftp: true }),
  "server.metrics": z.object({ serverId: z.uuid(), sample: WorkloadMetricSample }),
  "console.lines": ConsoleLinesEvent,
  "job.updated": Job,
  "job.log": JobLogLine.extend({ jobId: z.uuid() }),
  "alert.updated": AlertIncident,
  "backup.updated": Backup,
  "backup.deleted": z.object({ serverId: z.uuid(), backupId: z.uuid() }),
  "schedule.updated": Schedule,
  "schedule.deleted": z.object({ serverId: z.uuid(), scheduleId: z.uuid() }),
} as const satisfies Partial<Record<RealtimeEventType, z.ZodType>>;
