import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  CircleCheck,
  CircleX,
  Clock,
  CloudUpload,
  Download,
  Lock,
  LockOpen,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  BACKUP_COUNTED_STATUSES,
  CreateBackupRequest,
  OPERATION_ALLOWED_FROM,
  REALTIME_EVENT_PAYLOADS,
} from "@blockforge/contracts";
import type { Backup, Me, Schedule, Server } from "@blockforge/contracts";
import { backupsApi, schedulesApi } from "@/lib/api/phase4-api";
import { ApiError, describeError } from "@/lib/api/errors";
import { formatBytes, formatTimestamp } from "@/lib/format";
import { isUncertainFailure, useIdempotencyKeys } from "@/lib/idempotency";
import { useApiMutation } from "@/lib/mutations";
import {
  applyBackupEvent,
  reconcileList,
  removeBackupFromCache,
  restoreAfterFailedDelete,
} from "@/lib/phase4-cache";
import { jobQuery } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { useRealtimeTopic } from "@/lib/realtime/provider";
import { serverActionable, serverCan } from "@/lib/server-permissions";
import { PatternHelp, linesToList } from "@/components/common/pattern-help";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Timestamp } from "@/components/common/timestamp";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { StatusBadge, statusMeta } from "@/components/ui/status";
import type { StatusMeta } from "@/components/ui/status";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { InfoTip, Tooltip } from "@/components/ui/tooltip";
import { JobErrorNotice } from "../server-jobs";

// ---------------------------------------------------------------------------------------------
// Presentation

export const BACKUP_STATUS_META: Record<Backup["status"], StatusMeta> = {
  pending: {
    label: "Pending",
    tone: "neutral",
    icon: Clock,
    description: "Queued — waits until no other operation (power action, restore…) runs on the server.",
  },
  running: {
    label: "Running",
    tone: "info",
    icon: RefreshCw,
    description: "The archive is being written on the node.",
  },
  uploading: {
    label: "Uploading",
    tone: "info",
    icon: CloudUpload,
    description: "The archive is being uploaded to S3 storage; the local copy is removed afterwards.",
  },
  completed: {
    label: "Completed",
    tone: "success",
    icon: CircleCheck,
    description: "Ready to download or restore.",
  },
  failed: {
    label: "Failed",
    tone: "danger",
    icon: CircleX,
    description: "The backup did not complete; see the error. It does not count as a restorable backup.",
  },
};

export const CONSISTENCY_INFO: Record<NonNullable<Backup["consistency"]>, { label: string; help: string }> = {
  live: {
    label: "Live",
    help: "Archived while the server kept running and writing. Files changed during the backup (worlds, databases) may be inconsistent.",
  },
  "save-flush": {
    label: "Saved & flushed",
    help: "Minecraft saved and flushed the world first (save-off, save-all flush), the archive was written, then saving was switched back on — consistent without downtime.",
  },
  stopped: {
    label: "Server stopped",
    help: "The server was stopped for the backup and started again afterwards — an exact snapshot.",
  },
};

const ACTIVE: ReadonlySet<Backup["status"]> = new Set(["pending", "running", "uploading"]);

const COUNTED: ReadonlySet<string> = new Set(BACKUP_COUNTED_STATUSES);

/** Backups that occupy a slot toward `backupLimit` (contract: failed ones don't count). */
export function backupsUsed(backups: readonly Backup[]): number {
  return backups.filter((b) => COUNTED.has(b.status)).length;
}

/** Whether a rotation could free a slot: an unlocked, completed backup exists. */
export function canRotate(backups: readonly Backup[]): boolean {
  return backups.some((b) => b.status === "completed" && !b.locked);
}

/** Same-origin download URLs are single-use transfer tokens streamed through the agent. */
export const TRANSFER_PATH_PREFIX = "/api/v1/transfers/";

/**
 * Download URL policy: this origin only for `/api/v1/transfers/…`; any other origin only as an
 * absolute `https:` URL (presigned S3) without credentials. Protocol-relative (`//host/…`),
 * `javascript:`, `data:`, `http:` and `user:pass@` URLs are refused.
 */
export function isSafeDownloadUrl(url: string, origin = window.location.origin): boolean {
  const raw = url.trim();
  if (raw.startsWith("//") || raw.startsWith("\\\\")) return false;
  let u: URL;
  try {
    u = new URL(raw, origin);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.origin === origin) return u.pathname.startsWith(TRANSFER_PATH_PREFIX);
  return u.protocol === "https:" && /^https:\/\//i.test(raw);
}

/** Start a download in a new browsing context that gets neither an opener nor a referrer. */
export function openDownload(url: string, fileName: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.referrerPolicy = "no-referrer";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function downloadBackup(serverId: string, backup: Backup): Promise<void> {
  const { url } = await backupsApi.downloadUrl(serverId, backup.id);
  if (!isSafeDownloadUrl(url))
    throw new ApiError({ code: "INVALID_RESPONSE", message: "Unexpected download URL.", status: 0 });
  openDownload(url, `${backup.name || backup.id}.tar.gz`);
}

export function createdByLabel(
  backup: Pick<Backup, "createdBy" | "createdByName" | "scheduleId">,
  me: Pick<Me, "user">,
  schedules: readonly Pick<Schedule, "id" | "name">[] = [],
): string {
  if (backup.scheduleId) {
    const s = schedules.find((x) => x.id === backup.scheduleId);
    return s ? `Schedule “${s.name}”` : "A schedule";
  }
  if (!backup.createdBy) return "System";
  if (backup.createdBy === me.user.id) return "You";
  // The name is resolved at read time; null when the account no longer exists.
  return backup.createdByName ?? "A deleted user";
}

// ---------------------------------------------------------------------------------------------
// Live progress of a running backup job

function BackupProgress({ backup }: { backup: Backup }) {
  const queryClient = useQueryClient();
  const jobId = backup.jobId!;
  const job = useQuery({
    ...jobQuery(jobId),
    refetchInterval: (q) =>
      q.state.data && ["succeeded", "failed", "cancelled"].includes(q.state.data.status) ? false : 5_000,
    retry: false,
  });
  useRealtimeTopic(`job:${jobId}`, (event) => {
    if (event.type !== "job.updated") return;
    const parsed = REALTIME_EVENT_PAYLOADS["job.updated"].safeParse(event.data);
    if (parsed.success) queryClient.setQueryData(qk.jobs.detail(jobId), parsed.data);
  });
  const steps = job.data?.steps ?? [];
  if (steps.length === 0) return null;
  const done = steps.filter((s) => s.status === "succeeded" || s.status === "skipped").length;
  const current = steps.find((s) => s.status === "running");
  return (
    <div className="mt-1 flex max-w-56 flex-col gap-1">
      <Progress value={(done / steps.length) * 100} label={`Progress of ${backup.name || "backup"}`} />
      <span className="truncate text-[11px] text-muted-foreground">
        {done}/{steps.length}
        {current ? ` · ${current.label}` : ""}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Create

function CreateBackupDialog({
  server,
  backups,
  open,
  onOpenChange,
}: {
  server: Server;
  backups: readonly Backup[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [ignore, setIgnore] = useState("");
  const [stopServer, setStopServer] = useState(false);
  const [locked, setLocked] = useState(false);
  const [rotate, setRotate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const keys = useIdempotencyKeys<"create">();
  const inFlight = keys.isLocked("create");
  const used = backupsUsed(backups);
  const atLimit = used >= server.backupLimit;
  const rotationPossible = canRotate(backups);
  const blocked = atLimit && (!rotate || !rotationPossible);
  // Any change to the request body needs a new idempotency key (never while one is unresolved).
  const change =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      if (inFlight) return;
      set(v);
      keys.invalidate("create");
    };
  const create = useApiMutation({
    mutationFn: (body: ReturnType<typeof CreateBackupRequest.parse>) =>
      backupsApi.create(server.id, body, keys.sent("create")),
    success: "Backup started",
    errorTitle: "Could not start the backup",
    silentError: true,
    onError: (err) => {
      keys.settle("create", { ok: false, error: err });
      setError(describeError(err).title);
    },
    onSuccess: (r) => {
      keys.settle("create", { ok: true });
      applyBackupEvent(queryClient, r.backup);
      setName("");
      setIgnore("");
      setStopServer(false);
      setLocked(false);
      setRotate(false);
      setError(null);
      onOpenChange(false);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (blocked) return;
    const parsed = CreateBackupRequest.safeParse({
      name: name.trim() || undefined,
      ignore: linesToList(ignore),
      locked,
      stopServer,
      rotate,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid backup settings.");
      return;
    }
    setError(null);
    create.mutate(parsed.data);
  };
  const minecraft = server.game === "minecraft-java";
  return (
    <Dialog open={open} onOpenChange={(o) => !create.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-xl">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Create a backup</DialogTitle>
            <DialogDescription>
              {used} / {server.backupLimit} backups used on this server.
            </DialogDescription>
          </DialogHeader>
          <Field label="Name" hint="Optional — defaults to the date and time.">
            <Input
              value={name}
              onChange={(e) => change(setName)(e.target.value)}
              maxLength={120}
              disabled={inFlight}
            />
          </Field>
          <div className="flex flex-col gap-1.5">
            <Field
              label="Ignore"
              hint="Files and folders to leave out, one pattern per line. .blockforgeignore / .pteroignore in the server root apply too."
            >
              <Textarea
                value={ignore}
                onChange={(e) => change(setIgnore)(e.target.value)}
                rows={3}
                className="font-mono text-xs"
                spellCheck={false}
                disabled={inFlight}
              />
            </Field>
            <PatternHelp />
          </div>
          <SwitchRow
            id="backup-stop"
            label="Stop the server for an exact snapshot"
            hint={
              stopServer
                ? "The server is stopped during the backup and started again afterwards (short downtime)."
                : minecraft
                  ? "Without it, a running Minecraft server is saved and flushed first (save-off, save-all flush) — consistent, no downtime."
                  : "Without it, a running server is archived live; files written meanwhile may be inconsistent."
            }
            checked={stopServer}
            onCheckedChange={change(setStopServer)}
            disabled={inFlight}
          />
          <SwitchRow
            id="backup-lock"
            label="Lock"
            hint="Locked backups are never rotated out or deleted until unlocked."
            checked={locked}
            onCheckedChange={change(setLocked)}
            disabled={inFlight}
          />
          <SwitchRow
            id="backup-rotate"
            label="Rotate at the limit"
            hint="When the limit is reached, delete the oldest unlocked completed backup first."
            checked={rotate}
            onCheckedChange={change(setRotate)}
            disabled={inFlight}
          />
          {atLimit && !rotate ? (
            <Callout tone="warning" title="Backup limit reached">
              This server already has {used} of {server.backupLimit} backups. Turn on “Rotate at the limit” to
              replace the oldest unlocked backup, or delete one first.
            </Callout>
          ) : null}
          {atLimit && rotate && !rotationPossible ? (
            <Callout tone="warning" title="Nothing can be rotated out">
              Every completed backup is locked (or still running). Unlock or delete one first.
            </Callout>
          ) : null}
          {inFlight ? (
            <p role="status" className="text-xs">
              The previous request's outcome is unknown; creating again retries exactly the same backup.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={blocked}>
              Create backup
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SwitchRow({
  id,
  label,
  hint,
  checked,
  onCheckedChange,
  disabled,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        className="mt-0.5"
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Restore

export interface RestoreOptions {
  truncate: boolean;
  safetyBackup: boolean;
  startAfter: boolean;
}
const DEFAULT_RESTORE: RestoreOptions = { truncate: false, safetyBackup: true, startAfter: true };

/** One idempotency key per (backup, options): changing either is a different request. */
export function restoreAction(backupId: string, o: RestoreOptions): string {
  return `${backupId}:${o.truncate ? 1 : 0}${o.safetyBackup ? 1 : 0}${o.startAfter ? 1 : 0}`;
}

function RestoreDialog({
  server,
  backup,
  atLimit,
  onClose,
}: {
  server: Server;
  backup: Backup | null;
  atLimit: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [opts, setOpts] = useState<RestoreOptions>(DEFAULT_RESTORE);
  const [typed, setTyped] = useState("");
  // A restore whose outcome is unknown (lost response, 5xx, still in progress): its backup and
  // options are frozen, and confirming again replays it with the same key.
  const [uncertain, setUncertain] = useState<{ backupId: string; opts: RestoreOptions } | null>(null);
  const keys = useIdempotencyKeys<string>();
  const locked = backup !== null && uncertain?.backupId === backup.id;
  useEffect(() => {
    if (!backup) return;
    setOpts(uncertain?.backupId === backup.id ? uncertain.opts : DEFAULT_RESTORE);
    setTyped("");
    // Only when another backup is opened; `uncertain` changes are handled by `locked`.
  }, [backup?.id]);
  const restore = useApiMutation({
    mutationFn: ({ backupId, opts: o }: { backupId: string; opts: RestoreOptions }) =>
      backupsApi.restore(server.id, backupId, o, keys.sent(restoreAction(backupId, o))),
    success: "Restore started",
    errorTitle: "Could not start the restore",
    onError: (error, vars) => {
      keys.settle(restoreAction(vars.backupId, vars.opts), { ok: false, error });
      setUncertain(isUncertainFailure(error) ? vars : null);
    },
    onSuccess: async (_r, vars) => {
      keys.settle(restoreAction(vars.backupId, vars.opts), { ok: true });
      setUncertain(null);
      setOpts(DEFAULT_RESTORE);
      setTyped("");
      onClose();
      // The restore holds the server's operation lock; the page shows its progress.
      await queryClient.invalidateQueries({ queryKey: qk.servers.detail(server.id) });
    },
  });
  const set = (k: keyof RestoreOptions) => (v: boolean) => {
    if (locked) return;
    setOpts((o) => ({ ...o, [k]: v }));
    if (k === "truncate") setTyped("");
  };
  const close = () => {
    if (restore.isPending) return;
    setTyped("");
    onClose();
  };
  // Restore may start from running/degraded: the job stops the server first.
  const running = server.state === "running" || server.state === "degraded";
  const confirmed = !opts.truncate || typed === server.name;
  return (
    <Dialog open={backup !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Restore “{backup?.name ?? ""}”?</DialogTitle>
          <DialogDescription>
            Created {backup ? formatTimestamp(backup.createdAt) : ""}. The backup's files are written over the
            server's current files.
          </DialogDescription>
        </DialogHeader>
        {running ? (
          <Callout tone="warning">
            The server is running; it will be stopped before the files are restored.
          </Callout>
        ) : null}
        <SwitchRow
          id="restore-truncate"
          label="Delete all current files first"
          hint={
            opts.truncate
              ? "Every file except .blockforge/ is deleted before extracting: the server ends up exactly as in the backup. Files created since the backup are lost."
              : "Off: files in the backup replace their current versions; files that are not in the backup are kept."
          }
          checked={opts.truncate}
          onCheckedChange={set("truncate")}
          disabled={locked}
        />
        {opts.truncate ? (
          <Field label={`Type ${server.name} to confirm deleting the current files`}>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        ) : null}
        <SwitchRow
          id="restore-safety"
          label="Take a safety backup first"
          hint={
            atLimit
              ? "The server is at its backup limit, so the safety backup will be skipped — delete a backup first if you want one."
              : "A locked backup of the current files is taken first so the restore can be undone. It counts toward the limit."
          }
          checked={opts.safetyBackup}
          onCheckedChange={set("safetyBackup")}
          disabled={locked}
        />
        <SwitchRow
          id="restore-start"
          label="Start the server afterwards"
          hint="Starts the server once the files are restored."
          checked={opts.startAfter}
          onCheckedChange={set("startAfter")}
          disabled={locked}
        />
        {locked ? (
          <p role="status" className="text-xs">
            A restore with these options was already sent and its outcome is unknown; restoring again retries
            exactly the same request.
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={restore.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={restore.isPending}
            disabled={!confirmed}
            onClick={() => backup && restore.mutate({ backupId: backup.id, opts })}
          >
            <ArchiveRestore aria-hidden />
            Restore
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Delete job follow-up

const TERMINAL_JOB = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Follows a backup's delete job. The row was hidden at once (tombstone); if the job fails or is
 * cancelled the backup still exists, so the tombstone is lifted, the list re-read and the failure
 * shown. Without access to the job (403/404) nothing more can be learnt: the tombstone TTL is the
 * last-resort valve then.
 */
function DeleteJobNotice({
  serverId,
  jobId,
  backup,
  onDone,
}: {
  serverId: string;
  jobId: string;
  backup: Backup;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const job = useQuery({
    ...jobQuery(jobId),
    // Realtime normally settles it; the poll covers a missed event.
    refetchInterval: (q) =>
      q.state.status === "error" || (q.state.data && TERMINAL_JOB.has(q.state.data.status)) ? false : 3_000,
    retry: false,
  });
  useRealtimeTopic(`job:${jobId}`, (event) => {
    if (event.type !== "job.updated") return;
    const parsed = REALTIME_EVENT_PAYLOADS["job.updated"].safeParse(event.data);
    if (parsed.success && parsed.data.id === jobId)
      queryClient.setQueryData(qk.jobs.detail(jobId), parsed.data);
  });
  const status = job.data?.status;
  const failed = status === "failed" || status === "cancelled";
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    if (failed) void restoreAfterFailedDelete(queryClient, "backups", serverId, backup.id);
    else if (status === "succeeded" || job.isError) doneRef.current();
  }, [failed, status, job.isError, queryClient, serverId, backup.id]);
  if (!failed || !job.data) return null;
  const label = backup.name || formatTimestamp(backup.createdAt);
  return (
    <JobErrorNotice
      title={`Deleting “${label}” failed`}
      error={
        job.data.error ??
        (status === "cancelled"
          ? { code: "CANCELLED", message: "The delete job was cancelled; the backup was kept." }
          : {
              code: "UNKNOWN",
              message: "The delete job failed without an error message; the backup was kept.",
            })
      }
      onDismiss={onDone}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Tab

export default function BackupsTab({ server, me }: { server: Server; me: Me }) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const [removing, setRemoving] = useState<Backup | null>(null);
  /** Delete jobs being followed until they succeed (or their failure is dismissed). */
  const [deleteJobs, setDeleteJobs] = useState<Array<{ jobId: string; backup: Backup }>>([]);
  const list = useQuery({
    queryKey: qk.server(server.id).backups,
    // Kept live by backup.updated / backup.deleted on server:<id> (no polling); deleted rows stay
    // hidden even if a fetch that predates the delete returns them.
    queryFn: async ({ signal }) =>
      reconcileList(queryClient, "backups", server.id, await backupsApi.list(server.id, signal)),
  });
  const backups = list.data ?? [];
  const scheduled = backups.some((b) => b.scheduleId);
  const schedules = useQuery({
    queryKey: qk.server(server.id).schedules,
    queryFn: async ({ signal }) =>
      reconcileList(queryClient, "schedules", server.id, await schedulesApi.list(server.id, signal)),
    enabled: scheduled && serverCan(server, "schedules.view"),
  });

  const canCreate = serverActionable(server, "servers.backups.create");
  const canRestore = serverActionable(server, "servers.backups.restore");
  const canDownload = serverCan(server, "servers.backups.download");
  const canManage = serverActionable(server, "servers.backups.delete");
  const canViewJobs = serverCan(server, "jobs.view");
  const disabled = server.backupLimit === 0;
  const used = backupsUsed(backups);
  const backupAllowed = OPERATION_ALLOWED_FROM.backup.includes(server.state) && !server.activeOperation;
  const restoreAllowed = OPERATION_ALLOWED_FROM.restore.includes(server.state) && !server.activeOperation;

  const lock = useApiMutation({
    mutationFn: (b: Backup) => backupsApi.update(server.id, b.id, { locked: !b.locked }),
    success: (b) => (b.locked ? `${b.name} locked` : `${b.name} unlocked`),
    errorTitle: "Could not change the lock",
    onSuccess: (b) => applyBackupEvent(queryClient, b),
  });
  const remove = useApiMutation({
    mutationFn: (b: Backup) => backupsApi.remove(server.id, b.id),
    success: "Backup is being deleted",
    errorTitle: "Could not delete the backup",
    onSuccess: async (r, b) => {
      setRemoving(null);
      setDeleteJobs((list) => [...list, { jobId: r.jobId, backup: b }]);
      await removeBackupFromCache(queryClient, server.id, b.id);
    },
  });
  const download = useApiMutation({
    mutationFn: (b: Backup) => downloadBackup(server.id, b),
    errorTitle: "Download failed",
  });

  const createReason = disabled
    ? "Backups are disabled for this server."
    : !canCreate
      ? server.suspended
        ? "This server is suspended."
        : "You don't have permission to create backups."
      : !backupAllowed
        ? server.activeOperation
          ? `Wait for the current ${server.activeOperation} to finish.`
          : `Not possible while the server is ${server.state.replace("_", " ")}.`
        : null;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Backups</CardTitle>
          <CardDescription>
            {disabled ? "Backups are disabled for this server." : `${used} / ${server.backupLimit} used`}
          </CardDescription>
        </div>
        {serverCan(server, "servers.backups.create") ? (
          <Tooltip content={createReason}>
            <span>
              <Button size="sm" onClick={() => setCreating(true)} disabled={createReason !== null}>
                <Plus aria-hidden />
                Create backup
              </Button>
            </span>
          </Tooltip>
        ) : null}
      </CardHeader>
      {deleteJobs.length ? (
        <div className="mx-4 mb-3 flex flex-col gap-2 empty:hidden">
          {deleteJobs.map((d) => (
            <DeleteJobNotice
              key={d.jobId}
              serverId={server.id}
              jobId={d.jobId}
              backup={d.backup}
              onDone={() => setDeleteJobs((list) => list.filter((x) => x.jobId !== d.jobId))}
            />
          ))}
        </div>
      ) : null}
      {disabled ? (
        <Callout tone="info" className="mx-4 mb-3" title="Backups are disabled for this server">
          Its backup limit is 0. An administrator can raise it under Settings → Administration.
          {backups.length > 0 ? " Existing backups stay available below." : ""}
        </Callout>
      ) : null}
      {list.isPending ? (
        <TableSkeleton columns={6} rows={3} />
      ) : list.isError ? (
        <ErrorState
          error={list.error}
          onRetry={() => void list.refetch()}
          title="Could not load backups"
          compact
        />
      ) : backups.length === 0 ? (
        <EmptyState
          icon={Archive}
          title="No backups yet"
          description={disabled ? undefined : "Create one now, or add a backup task to a schedule."}
          compact
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Backup</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead>Storage</TableHead>
                <TableHead>Consistency</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {backups.map((b) => {
                const completed = b.status === "completed";
                const label = b.name || formatTimestamp(b.createdAt);
                return (
                  <TableRow key={b.id} aria-busy={ACTIVE.has(b.status) || undefined}>
                    <TableCell className="max-w-72">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate font-medium" title={label}>
                          {label}
                        </span>
                        {b.locked ? (
                          <Badge tone="info" title="Never rotated out or deleted until unlocked">
                            <Lock aria-hidden />
                            Locked
                          </Badge>
                        ) : null}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        by {createdByLabel(b, me, schedules.data)}
                        {b.ignored.length ? ` · ${b.ignored.length} ignore pattern(s)` : ""}
                        {b.skippedSymlinks ? ` · ${b.skippedSymlinks} symlink(s) not archived` : ""}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge meta={statusMeta(BACKUP_STATUS_META, b.status)} />
                      {ACTIVE.has(b.status) && b.jobId && canViewJobs ? <BackupProgress backup={b} /> : null}
                      {b.status === "failed" && b.error ? (
                        <p className="mt-1 max-w-64 text-xs break-words text-danger">{b.error}</p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap tabular">
                      {formatBytes(b.sizeBytes)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{b.storage === "s3" ? "S3" : "Local"}</Badge>
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {b.consistency ? (
                        <span className="inline-flex items-center gap-1">
                          {CONSISTENCY_INFO[b.consistency].label}
                          <InfoTip label={`About “${CONSISTENCY_INFO[b.consistency].label}”`}>
                            {CONSISTENCY_INFO[b.consistency].help}
                          </InfoTip>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      <Timestamp ts={b.createdAt} />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {canDownload ? (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Download ${label}`}
                            title="Download"
                            disabled={!completed}
                            loading={download.isPending && download.variables?.id === b.id}
                            onClick={() => download.mutate(b)}
                          >
                            <Download aria-hidden />
                          </Button>
                        ) : null}
                        {canRestore ? (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Restore ${label}`}
                            title={restoreAllowed ? "Restore" : "Wait for the current operation to finish"}
                            disabled={!completed || !restoreAllowed}
                            onClick={() => setRestoring(b)}
                          >
                            <ArchiveRestore aria-hidden />
                          </Button>
                        ) : null}
                        {canManage ? (
                          <>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`${b.locked ? "Unlock" : "Lock"} ${label}`}
                              title={b.locked ? "Unlock" : "Lock"}
                              loading={lock.isPending && lock.variables?.id === b.id}
                              onClick={() => lock.mutate(b)}
                            >
                              {b.locked ? <LockOpen aria-hidden /> : <Lock aria-hidden />}
                            </Button>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Delete ${label}`}
                              title={b.locked ? "Unlock the backup to delete it" : "Delete"}
                              disabled={b.locked || ACTIVE.has(b.status)}
                              onClick={() => setRemoving(b)}
                            >
                              <Trash2 aria-hidden />
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      <CreateBackupDialog server={server} backups={backups} open={creating} onOpenChange={setCreating} />
      <RestoreDialog
        server={server}
        backup={restoring}
        atLimit={used >= server.backupLimit}
        onClose={() => setRestoring(null)}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Delete backup?"
        description={`“${removing ? removing.name || formatTimestamp(removing.createdAt) : ""}” is deleted permanently${removing?.storage === "s3" ? " from S3 storage" : " from the node"}. This cannot be undone.`}
        confirmLabel="Delete backup"
        destructive
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </Card>
  );
}
