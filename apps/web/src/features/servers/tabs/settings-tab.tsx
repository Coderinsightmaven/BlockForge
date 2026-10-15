import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";
import { OPERATION_ALLOWED_FROM, UpdateServerBuildRequest } from "@blockforge/contracts";
import type { Me, Server } from "@blockforge/contracts";
import type { z } from "zod";
import { serversApi } from "@/lib/api/servers-api";
import { fieldErrorsFrom } from "@/lib/api/errors";
import { useIdempotencyKeys } from "@/lib/idempotency";
import { formatBytes } from "@/lib/format";
import { useApiMutation } from "@/lib/mutations";
import { hasGlobal } from "@/lib/permissions";
import { usersQuery } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { upsertServerInCache } from "@/lib/server-cache";
import { serverActionable, serverCan } from "@/lib/server-permissions";
import { useSyncedForm } from "@/lib/use-synced-form";
import { ChangedElsewhere } from "@/components/common/changed-elsewhere";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyButton } from "@/components/ui/copy-button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

const detailsFrom = (s: Server) => ({ name: s.name, description: s.description });

function GeneralCard({ server }: { server: Server }) {
  const queryClient = useQueryClient();
  // Live server updates refresh the fields only while they hold no unsaved edits.
  const details = useSyncedForm(server, detailsFrom);
  const { name, description } = details.form ?? detailsFrom(server);
  const setName = (v: string) => details.setForm((f) => ({ ...f, name: v }));
  const setDescription = (v: string) => details.setForm((f) => ({ ...f, description: v }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const canEdit = serverActionable(server, "servers.settings.edit");
  const save = useApiMutation({
    mutationFn: () =>
      serversApi.updateSettings(server.id, { name: name.trim(), description: description.trim() }),
    success: "Server details saved",
    errorTitle: "Could not save",
    onSuccess: (s) => {
      upsertServerInCache(queryClient, s);
      details.reset(s);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || n.length > 80) {
      setErrors({ name: "Use 1–80 characters." });
      return;
    }
    setErrors({});
    save.mutate(undefined, { onError: (err) => setErrors(fieldErrorsFrom(err)) });
  };
  const dirty = details.dirty;
  return (
    <form onSubmit={submit}>
      <Card>
        <CardHeader>
          <CardTitle>Server details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {details.changedElsewhere ? <ChangedElsewhere onDiscard={() => details.reset()} /> : null}
          <Field label="Name" error={errors.name}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              disabled={!canEdit}
            />
          </Field>
          <Field label="Description" error={errors.description}>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1024}
              rows={3}
              disabled={!canEdit}
            />
          </Field>
          <dl className="grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
            <div>
              ID <code className="font-mono text-foreground">{server.id}</code>
            </div>
            <div>
              Template <span className="text-foreground">{server.templateName}</span>
            </div>
            <div>
              Image <code className="font-mono break-all text-foreground">{server.dockerImage}</code>
            </div>
            <div>
              Node <span className="text-foreground">{server.nodeName}</span>
            </div>
          </dl>
        </CardContent>
        {canEdit ? (
          <CardFooter className="justify-end">
            <Button type="submit" disabled={!dirty} loading={save.isPending}>
              Save
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </form>
  );
}

function SftpCard({ server }: { server: Server }) {
  const sftp = server.sftp;
  if (!sftp) return null;
  const url = `sftp://${sftp.username}@${sftp.host}:${sftp.port}`;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>SFTP</CardTitle>
          <CardDescription>
            Connect with any SFTP client. Use your BlockForge password, or an SSH key from{" "}
            <Link to="/settings" search={{ tab: "ssh" }} className="text-primary hover:underline">
              Account → SSH keys
            </Link>
            . Password login is refused when your account uses two-factor authentication.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-2 text-sm">
          {[
            ["Address", url],
            ["Host", sftp.host],
            ["Port", String(sftp.port)],
            ["Username", sftp.username],
            ["Host key fingerprint", sftp.hostKeyFingerprint],
          ].map(([k, v]) => (
            <div key={k} className="grid items-center gap-1 sm:grid-cols-[11rem_1fr]">
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="flex min-w-0 items-center gap-1.5">
                <code className="min-w-0 truncate font-mono text-xs" title={v}>
                  {v}
                </code>
                <CopyButton value={v!} label={`Copy ${k}`} className="size-6" />
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">
          Verify the fingerprint the first time you connect; a different fingerprint means you are not talking
          to this node.
        </p>
      </CardContent>
    </Card>
  );
}

function ReinstallCard({ server }: { server: Server }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const keys = useIdempotencyKeys<"reinstall">();
  const allowed = OPERATION_ALLOWED_FROM.reinstall.includes(server.state) && !server.activeOperation;
  const reinstall = useApiMutation({
    mutationFn: () => serversApi.reinstall(server.id, keys.sent("reinstall")),
    success: "Reinstall started",
    errorTitle: "Could not reinstall",
    onError: (error) => keys.settle("reinstall", { ok: false, error }),
    onSuccess: async () => {
      keys.settle("reinstall", { ok: true });
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: qk.servers.detail(server.id) });
    },
  });
  if (!serverCan(server, "servers.reinstall")) return null;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Reinstall</CardTitle>
          <CardDescription>
            Re-runs the install step (
            {server.templateKind === "egg"
              ? "the template's install script"
              : "artifact download and configuration"}
            ). Files the installer writes are replaced; other files are kept.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          disabled={!allowed || !serverActionable(server, "servers.reinstall")}
          title={allowed ? undefined : "Stop the server first"}
          onClick={() => setOpen(true)}
        >
          Reinstall…
        </Button>
      </CardHeader>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Reinstall ${server.name}?`}
        description="The server stays stopped while the installer runs. Make a backup first if you changed files the installer manages (jars, configs it generates)."
        confirmLabel="Reinstall"
        destructive
        pending={reinstall.isPending}
        onConfirm={() => reinstall.mutate()}
      />
    </Card>
  );
}

type BuildForm = {
  memoryMiB: string;
  cpuCores: string;
  diskGiB: string;
  allocationLimit: string;
  backupLimit: string;
  databaseLimit: string;
  startup: "manual" | "auto";
  restartMode: Server["restartPolicy"]["mode"];
  maxRetries: string;
};

function formFromServer(s: Server): BuildForm {
  return {
    memoryMiB: String(Math.round(s.memoryLimitBytes / MiB)),
    cpuCores: s.cpuLimitMillicores ? String(s.cpuLimitMillicores / 1000) : "",
    diskGiB: s.storageQuotaBytes ? String(Math.round((s.storageQuotaBytes / GiB) * 100) / 100) : "",
    allocationLimit: String(s.allocationLimit),
    backupLimit: String(s.backupLimit),
    databaseLimit: String(s.databaseLimit),
    startup: s.startup,
    restartMode: s.restartPolicy.mode,
    maxRetries: String(s.restartPolicy.maxRetries),
  };
}

/** Changed fields only, validated against `UpdateServerBuildRequest`. */
export function buildPatch(
  s: Server,
  f: BuildForm,
): { patch: z.input<typeof UpdateServerBuildRequest>; errors: Record<string, string> } {
  const patch: z.input<typeof UpdateServerBuildRequest> = {};
  const errors: Record<string, string> = {};
  const mem = Math.round(Number(f.memoryMiB) * MiB);
  if (!Number.isFinite(mem) || mem < 256 * MiB) errors.memoryMiB = "At least 256 MiB.";
  else if (mem !== s.memoryLimitBytes) patch.memoryLimitBytes = mem;
  if (f.cpuCores.trim() === "") {
    if (s.cpuLimitMillicores !== null) patch.cpuLimitMillicores = null;
  } else {
    const mc = Math.round(Number(f.cpuCores) * 1000);
    if (!Number.isFinite(mc) || mc < 250) errors.cpuCores = "At least 0.25 cores, or empty for no limit.";
    else if (mc !== s.cpuLimitMillicores) patch.cpuLimitMillicores = mc;
  }
  if (f.diskGiB.trim() === "") {
    if (s.storageQuotaBytes !== null) patch.storageQuotaBytes = null;
  } else {
    const b = Math.round(Number(f.diskGiB) * GiB);
    if (!Number.isFinite(b) || b <= 0) errors.diskGiB = "Enter a size, or empty for no quota.";
    else if (b !== s.storageQuotaBytes) patch.storageQuotaBytes = b;
  }
  const al = Number(f.allocationLimit);
  if (!Number.isInteger(al) || al < 0 || al > 50) errors.allocationLimit = "0–50.";
  else if (al !== s.allocationLimit) patch.allocationLimit = al;
  const bl = Number(f.backupLimit);
  if (!Number.isInteger(bl) || bl < 0 || bl > 100) errors.backupLimit = "0–100.";
  else if (bl !== s.backupLimit) patch.backupLimit = bl;
  const dl = Number(f.databaseLimit);
  if (f.databaseLimit.trim() === "" || !Number.isInteger(dl) || dl < 0 || dl > 100)
    errors.databaseLimit = "0–100.";
  else if (dl !== s.databaseLimit) patch.databaseLimit = dl;
  if (f.startup !== s.startup) patch.startup = f.startup;
  const retries = Number(f.maxRetries);
  if (!Number.isInteger(retries) || retries < 0 || retries > 100) errors.maxRetries = "0–100.";
  else if (f.restartMode !== s.restartPolicy.mode || retries !== s.restartPolicy.maxRetries) {
    patch.restartPolicy = { ...s.restartPolicy, mode: f.restartMode, maxRetries: retries };
  }
  const parsed = UpdateServerBuildRequest.safeParse(patch);
  if (!parsed.success) for (const i of parsed.error.issues) errors[String(i.path[0] ?? "form")] ??= i.message;
  return { patch, errors };
}

const adminFormFrom = (s: Server) => ({ limits: formFromServer(s), ownerId: s.ownerId });

function AdminCard({ me, server }: { me: Me; server: Server }) {
  const queryClient = useQueryClient();
  // Live server updates (state changes, other admins) refresh the form only while it holds no unsaved
  // edits; a changed limit or owner while editing shows "changed elsewhere" instead.
  const build = useSyncedForm(server, adminFormFrom);
  const form = build.form?.limits ?? formFromServer(server);
  const ownerId = build.form?.ownerId ?? server.ownerId;
  const setForm = (fn: (f: BuildForm) => BuildForm) => build.setForm((b) => ({ ...b, limits: fn(b.limits) }));
  const setOwnerId = (v: string) => build.setForm((b) => ({ ...b, ownerId: v }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [suspendOpen, setSuspendOpen] = useState(false);
  const canListUsers = hasGlobal(me, "users.view");
  const users = useInfiniteQuery({ ...usersQuery, enabled: canListUsers });
  const userOptions = users.data?.pages.flatMap((p) => p.items) ?? [];

  const save = useApiMutation({
    mutationFn: (patch: z.input<typeof UpdateServerBuildRequest>) => serversApi.updateBuild(server.id, patch),
    errorTitle: "Could not save limits",
    onSuccess: (r) => {
      upsertServerInCache(queryClient, r.server);
      build.reset(r.server);
      toast.success(
        "Limits saved",
        r.restartRequired ? { description: "Restart the server to apply them." } : undefined,
      );
    },
  });
  const suspend = useApiMutation({
    mutationFn: () => (server.suspended ? serversApi.unsuspend(server.id) : serversApi.suspend(server.id)),
    success: server.suspended ? "Server unsuspended" : "Server suspended",
    errorTitle: server.suspended ? "Could not unsuspend" : "Could not suspend",
    onSuccess: (s) => {
      upsertServerInCache(queryClient, s);
      setSuspendOpen(false);
    },
  });
  const set = (k: keyof BuildForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const { patch, errors: errs } = buildPatch(server, form);
    if (ownerId !== server.ownerId) patch.ownerId = ownerId;
    setErrors(errs);
    if (Object.keys(errs).length || Object.keys(patch).length === 0) return;
    save.mutate(patch, { onError: (err) => setErrors(fieldErrorsFrom(err)) });
  };
  if (!serverCan(server, "servers.admin")) return null;
  return (
    <form onSubmit={submit}>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Administration</CardTitle>
            <CardDescription>
              Resource limits and ownership. Memory/CPU changes apply on the next restart.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4">
          {build.changedElsewhere ? <ChangedElsewhere onDiscard={() => build.reset()} /> : null}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field
              label="Memory limit (MiB)"
              error={errors.memoryMiB ?? errors.memoryLimitBytes}
              hint={`Now ${formatBytes(server.memoryLimitBytes)}.`}
            >
              <Input
                type="number"
                min={256}
                step={256}
                value={form.memoryMiB}
                onChange={(e) => set("memoryMiB")(e.target.value)}
              />
            </Field>
            <Field
              label="CPU limit (cores)"
              error={errors.cpuCores ?? errors.cpuLimitMillicores}
              hint="Empty = no limit."
            >
              <Input
                type="number"
                min={0.25}
                step={0.25}
                value={form.cpuCores}
                onChange={(e) => set("cpuCores")(e.target.value)}
              />
            </Field>
            <Field
              label="Disk quota (GiB)"
              error={errors.diskGiB ?? errors.storageQuotaBytes}
              hint="Empty = no quota (soft limit)."
            >
              <Input
                type="number"
                min={0}
                step={1}
                value={form.diskGiB}
                onChange={(e) => set("diskGiB")(e.target.value)}
              />
            </Field>
            <Field label="Additional allocations" error={errors.allocationLimit}>
              <Input
                type="number"
                min={0}
                max={50}
                value={form.allocationLimit}
                onChange={(e) => set("allocationLimit")(e.target.value)}
              />
            </Field>
            <Field label="Backup limit" error={errors.backupLimit}>
              <Input
                type="number"
                min={0}
                max={100}
                value={form.backupLimit}
                onChange={(e) => set("backupLimit")(e.target.value)}
              />
            </Field>
            <Field
              label="Database limit"
              error={errors.databaseLimit}
              hint="MySQL databases its users may create; 0 = none (administrators are not limited)."
            >
              <Input
                type="number"
                min={0}
                max={100}
                value={form.databaseLimit}
                onChange={(e) => set("databaseLimit")(e.target.value)}
              />
            </Field>
            <Field label="Start with the node" error={errors.startup}>
              <Select
                value={form.startup}
                onValueChange={set("startup")}
                options={[
                  { value: "auto", label: "Automatically" },
                  { value: "manual", label: "Manually" },
                ]}
              />
            </Field>
            <Field label="Restart policy" error={errors.restartPolicy}>
              <Select
                value={form.restartMode}
                onValueChange={set("restartMode")}
                options={[
                  { value: "on-failure", label: "Restart after a crash" },
                  { value: "always", label: "Always restart" },
                  { value: "never", label: "Never restart" },
                ]}
              />
            </Field>
            <Field label="Max automatic restarts" error={errors.maxRetries}>
              <Input
                type="number"
                min={0}
                max={100}
                value={form.maxRetries}
                onChange={(e) => set("maxRetries")(e.target.value)}
              />
            </Field>
            {canListUsers ? (
              <Field label="Owner" error={errors.ownerId}>
                <Select
                  value={ownerId}
                  onValueChange={setOwnerId}
                  options={[
                    ...(userOptions.some((u) => u.id === server.ownerId)
                      ? []
                      : [{ value: server.ownerId, label: server.ownerName }]),
                    ...userOptions.map((u) => ({ value: u.id, label: `${u.displayName} (${u.username})` })),
                  ]}
                />
              </Field>
            ) : null}
          </div>
        </CardContent>
        <CardFooter className="justify-between">
          <Button variant={server.suspended ? "outline" : "destructive"} onClick={() => setSuspendOpen(true)}>
            {server.suspended ? "Unsuspend" : "Suspend…"}
          </Button>
          <Button type="submit" loading={save.isPending}>
            Save limits
          </Button>
        </CardFooter>
      </Card>
      <ConfirmDialog
        open={suspendOpen}
        onOpenChange={setSuspendOpen}
        title={server.suspended ? `Unsuspend ${server.name}?` : `Suspend ${server.name}?`}
        description={
          server.suspended
            ? "Its users regain access. The server is not started automatically."
            : "The server is stopped and its users can no longer start it or change anything until it is unsuspended."
        }
        confirmLabel={server.suspended ? "Unsuspend" : "Suspend"}
        destructive={!server.suspended}
        pending={suspend.isPending}
        onConfirm={() => suspend.mutate()}
      />
    </form>
  );
}

export function DeleteCard({ server }: { server: Server }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [deleteData, setDeleteData] = useState(true);
  // One key per request body: changing "also delete files" mints a new one, and once a request
  // was sent the choice is frozen until its outcome is known (a retry must replay the same body).
  const keys = useIdempotencyKeys<"delete">();
  const locked = keys.isLocked("delete");
  const allowed = OPERATION_ALLOWED_FROM.delete.includes(server.state) && !server.activeOperation;
  const remove = useApiMutation({
    mutationFn: () => serversApi.remove(server.id, deleteData, keys.sent("delete")),
    success: `${server.name} is being deleted`,
    errorTitle: "Could not delete the server",
    onError: (error) => keys.settle("delete", { ok: false, error }),
    onSuccess: async () => {
      keys.settle("delete", { ok: true });
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: qk.servers.all });
      await navigate({ to: "/servers" });
    },
  });
  if (!serverCan(server, "servers.delete")) return null;
  return (
    <Card className="border-danger/40">
      <CardHeader>
        <div>
          <CardTitle>Delete server</CardTitle>
          <CardDescription>
            Removes the server, its container and its allocations. Stop it first.
          </CardDescription>
        </div>
        <Button
          variant="destructive"
          disabled={!allowed}
          title={allowed ? undefined : "Stop the server first"}
          onClick={() => setOpen(true)}
        >
          Delete…
        </Button>
      </CardHeader>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${server.name}?`}
        description={
          <div className="flex flex-col gap-3">
            <p>This cannot be undone.</p>
            <div className="flex items-center gap-2">
              <Checkbox
                id="delete-data"
                checked={deleteData}
                disabled={locked}
                onCheckedChange={(c) => {
                  if (locked) return;
                  setDeleteData(c === true);
                  keys.invalidate("delete");
                }}
              />
              <Label htmlFor="delete-data" className="font-normal text-foreground">
                Also delete the server's files on the node
              </Label>
            </div>
            {locked ? (
              <p role="status" className="text-xs">
                A delete request {deleteData ? "including" : "keeping"} the files was already sent and its
                outcome is unknown; retrying sends exactly the same request.
              </p>
            ) : null}
            {!deleteData ? (
              <Callout tone="warning">
                Files stay on the node's disk until an administrator removes them.
              </Callout>
            ) : null}
          </div>
        }
        confirmLabel="Delete server"
        destructive
        confirmText={server.name}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </Card>
  );
}

export default function SettingsTab({ me, server }: { me: Me; server: Server }) {
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <div className="flex flex-col gap-3">
        {serverCan(server, "servers.settings.edit") ? <GeneralCard server={server} /> : null}
        <SftpCard server={server} />
        {serverCan(server, "servers.files.sftp") && !server.sftp ? (
          <Callout tone="info">SFTP is not available on this server's node.</Callout>
        ) : null}
      </div>
      <div className="flex flex-col gap-3">
        <AdminCard me={me} server={server} />
        <ReinstallCard server={server} />
        <DeleteCard server={server} />
      </div>
    </div>
  );
}
