import { useQuery } from "@tanstack/react-query";
import { CircleX, Info, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { ModrinthInstallPlan } from "@blockforge/contracts";
import type { ModrinthVersionSummary, PlanWarning, Server } from "@blockforge/contracts";
import { extensionsApi } from "@/lib/api/extensions-api";
import { describeError } from "@/lib/api/errors";
import { formatBytes, formatNumber, formatShortDate } from "@/lib/format";
import { isUncertainFailure, useIdempotencyKeys } from "@/lib/idempotency";
import { useApiMutation } from "@/lib/mutations";
import { qk } from "@/lib/query-keys";
import { ErrorState, TableSkeleton } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ExtensionIcon, SafeLink } from "./extension-ui";
import { groupPlanWarnings, installAction, installRequest, planChangedFrom } from "./extension-model";
import type { PlanOptions } from "./extension-model";

const LEVEL_UI: Record<PlanWarning["level"], { icon: typeof Info; className: string; title: string }> = {
  error: { icon: CircleX, className: "text-danger", title: "Blocking problems" },
  warning: { icon: TriangleAlert, className: "text-warning", title: "Warnings" },
  info: { icon: Info, className: "text-muted-foreground", title: "Notes" },
};

/** Max `expect` entries the install route accepts. */
const MAX_EXPECT = 64;

function versionCompat(v: ModrinthVersionSummary): { label: string; tone: "success" | "warning" | "danger" } {
  if (v.loaderMatch === "none") return { label: "Wrong loader", tone: "danger" };
  if (!v.gameVersionMatch) return { label: "Other Minecraft version", tone: "warning" };
  if (v.loaderMatch === "warning") return { label: "Loader warning", tone: "warning" };
  return { label: "Compatible", tone: "success" };
}

export default function ProjectDialog({
  server,
  project,
  canManage,
  onClose,
  onJob,
}: {
  server: Server;
  project: string;
  canManage: boolean;
  onClose: () => void;
  onJob: (jobId: string, title: string, restartRequired: boolean) => void;
}) {
  const [versionId, setVersionId] = useState<string | null>(null);
  const [allowPrerelease, setAllowPrerelease] = useState(false);
  const [allowIncompatibleVersion, setAllowIncompatible] = useState(false);
  const [includeOptional, setIncludeOptional] = useState<string[]>([]);
  // A fresh plan the control plane answered with (409 plan_changed): reviewed again before installing.
  const [changedPlan, setChangedPlan] = useState<ModrinthInstallPlan | null>(null);
  const details = useQuery({
    queryKey: qk.server(server.id).modrinthProject(project),
    queryFn: ({ signal }) => extensionsApi.project(server.id, project, signal),
    staleTime: 5 * 60_000,
  });
  const options: PlanOptions = useMemo(
    () => ({
      project,
      ...(versionId ? { versionId } : {}),
      includeOptional: [...includeOptional].sort(),
      allowPrerelease,
      allowIncompatibleVersion: versionId ? allowIncompatibleVersion : false,
    }),
    [project, versionId, includeOptional, allowPrerelease, allowIncompatibleVersion],
  );
  const planQuery = useQuery({
    queryKey: qk.server(server.id).modrinthPlan(options),
    queryFn: ({ signal }) => extensionsApi.plan(server.id, options, signal),
    enabled: details.isSuccess && details.data.project.compatible,
    staleTime: 0,
    retry: false,
  });
  const plan = changedPlan ?? planQuery.data ?? null;
  const keys = useIdempotencyKeys<string>();
  const body = plan ? installRequest(options, plan) : null;
  const locked = body ? keys.isLocked(installAction(body)) : false;
  const setOption = (fn: () => void) => {
    if (locked) return;
    setChangedPlan(null);
    fn();
  };
  const install = useApiMutation({
    mutationFn: (b: NonNullable<typeof body>) =>
      extensionsApi.install(server.id, b, keys.sent(installAction(b))),
    errorTitle: "Could not install",
    silentError: true,
    onError: (error, b) => {
      keys.settle(installAction(b), { ok: false, error });
      const fresh = planChangedFrom(error, (v) => {
        const p = ModrinthInstallPlan.safeParse(v);
        return p.success ? p.data : null;
      });
      if (fresh) setChangedPlan(fresh);
    },
    onSuccess: (r, b) => {
      keys.settle(installAction(b), { ok: true });
      onJob(r.jobId, `Installing ${plan?.root.title ?? project}`, plan?.restartRequired ?? false);
      onClose();
    },
  });
  const p = details.data?.project;
  const nameOf = (id: string) =>
    plan?.files.find((f) => f.projectId === id)?.projectTitle ??
    (plan?.root.projectId === id ? plan.root.title : id);
  const warnings = plan ? groupPlanWarnings(plan.warnings) : null;
  const tooMany = (plan?.files.length ?? 0) > MAX_EXPECT;
  const installError = install.error && !changedPlan ? describeError(install.error) : null;
  const uncertain = install.error && isUncertainFailure(install.error);
  return (
    <Dialog open onOpenChange={(o) => !o && !install.isPending && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <ExtensionIcon url={p?.iconUrl} className="size-12" />
            <div className="min-w-0">
              <DialogTitle className="break-words">{p?.title ?? project}</DialogTitle>
              <DialogDescription className="break-words whitespace-pre-line">
                {p?.description ?? "Loading…"}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        {details.isPending ? (
          <TableSkeleton columns={3} rows={3} />
        ) : details.isError ? (
          <ErrorState
            error={details.error}
            onRetry={() => void details.refetch()}
            title="Could not load the project"
            compact
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="tabular">{formatNumber(details.data.project.downloads, 0)} downloads</span>
              {details.data.project.license ? (
                <SafeLink href={details.data.project.license.url} className="underline">
                  {details.data.project.license.name || details.data.project.license.id}
                </SafeLink>
              ) : null}
              <SafeLink href={details.data.project.pageUrl} className="underline">
                Modrinth page
              </SafeLink>
              {details.data.project.sourceUrl ? (
                <SafeLink href={details.data.project.sourceUrl} className="underline">
                  Source
                </SafeLink>
              ) : null}
              {details.data.project.issuesUrl ? (
                <SafeLink href={details.data.project.issuesUrl} className="underline">
                  Issues
                </SafeLink>
              ) : null}
              {details.data.project.wikiUrl ? (
                <SafeLink href={details.data.project.wikiUrl} className="underline">
                  Wiki
                </SafeLink>
              ) : null}
              {details.data.installed.length ? <Badge tone="success">Installed</Badge> : null}
            </div>
            {!details.data.project.compatible ? (
              <Callout tone="danger" title="Not for this server">
                None of this project's loaders runs on {server.software ?? "this server"}.
              </Callout>
            ) : (
              <>
                <fieldset className="flex flex-col gap-1.5">
                  <legend className="mb-1 text-sm font-medium">Version</legend>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="version"
                      checked={versionId === null}
                      disabled={locked}
                      onChange={() => setOption(() => setVersionId(null))}
                    />
                    Best compatible version (automatic)
                  </label>
                  <div className="max-h-48 overflow-y-auto rounded-md border">
                    <Table>
                      <TableBody>
                        {details.data.versions.map((v) => {
                          const c = versionCompat(v);
                          return (
                            <TableRow key={v.versionId}>
                              <TableCell className="w-8">
                                <input
                                  type="radio"
                                  name="version"
                                  aria-label={`Version ${v.versionNumber}`}
                                  checked={versionId === v.versionId}
                                  disabled={locked || !v.primaryFile}
                                  onChange={() => setOption(() => setVersionId(v.versionId))}
                                />
                              </TableCell>
                              <TableCell className="text-sm">
                                <span className="font-medium break-words">{v.versionNumber}</span>{" "}
                                {v.versionType !== "release" ? (
                                  <Badge tone="warning">{v.versionType}</Badge>
                                ) : null}
                                <span className="block text-xs text-muted-foreground">
                                  {v.loaders.join(", ")} · {v.gameVersions.slice(-3).join(", ")}
                                  {v.gameVersions.length > 3 ? " …" : ""}
                                </span>
                              </TableCell>
                              <TableCell className="text-xs whitespace-nowrap">
                                {formatShortDate(v.datePublished)}
                              </TableCell>
                              <TableCell>
                                <Badge tone={c.tone}>{c.label}</Badge>
                                {!v.primaryFile ? (
                                  <span className="block text-[11px] text-muted-foreground">
                                    No installable file
                                  </span>
                                ) : null}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </fieldset>
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground">Advanced</summary>
                  <div className="mt-2 flex flex-col gap-2">
                    <div className="flex items-start gap-2">
                      <Switch
                        id="allow-prerelease"
                        checked={allowPrerelease}
                        disabled={locked}
                        onCheckedChange={(v) => setOption(() => setAllowPrerelease(v))}
                      />
                      <div>
                        <Label htmlFor="allow-prerelease">Allow beta and alpha versions</Label>
                        <p className="text-xs text-muted-foreground">
                          Also for dependencies. Pre-releases can be unstable.
                        </p>
                      </div>
                    </div>
                    {versionId ? (
                      <div className="flex items-start gap-2">
                        <Switch
                          id="allow-incompatible"
                          checked={allowIncompatibleVersion}
                          disabled={locked}
                          onCheckedChange={(v) => setOption(() => setAllowIncompatible(v))}
                        />
                        <div>
                          <Label htmlFor="allow-incompatible">
                            Install this version even if it doesn't list this Minecraft version
                          </Label>
                          <p className="text-xs text-muted-foreground">
                            Turns the version-mismatch error into a warning. A wrong loader is never allowed.
                          </p>
                        </div>
                      </div>
                    ) : null}
                    {allowPrerelease || allowIncompatibleVersion ? (
                      <Callout tone="warning">
                        These options can install versions that crash the server or damage worlds. Back up
                        first.
                      </Callout>
                    ) : null}
                  </div>
                </details>
                {planQuery.isPending && !changedPlan ? (
                  <p className="text-xs text-muted-foreground">Planning the install…</p>
                ) : planQuery.isError && !changedPlan ? (
                  <ErrorState
                    error={planQuery.error}
                    onRetry={() => void planQuery.refetch()}
                    title="Could not plan the install"
                    compact
                  />
                ) : plan ? (
                  <section aria-label="Install plan" className="flex flex-col gap-3">
                    {changedPlan ? (
                      <Callout tone="warning" title="The plan changed">
                        Something changed since you reviewed it (a new version, a dependency, or the installed
                        files). Check the files below and confirm again.
                      </Callout>
                    ) : null}
                    {plan.files.length ? (
                      <div className="overflow-x-auto rounded-md border">
                        <Table>
                          <TableHeader>
                            <TableRow className="hover:bg-transparent">
                              <TableHead>File</TableHead>
                              <TableHead>Why</TableHead>
                              <TableHead className="text-right">Size</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {plan.files.map((f) => (
                              <TableRow key={`${f.projectId}:${f.versionId}`}>
                                <TableCell className="text-sm">
                                  <Badge tone={f.action === "replace" ? "warning" : "info"}>
                                    {f.action === "replace" ? "Replace" : "Install"}
                                  </Badge>{" "}
                                  <span className="font-medium break-words">
                                    {f.projectTitle ?? f.projectSlug ?? f.projectId}
                                  </span>{" "}
                                  <span className="text-muted-foreground">{f.versionNumber}</span>
                                  {f.versionType !== "release" ? (
                                    <Badge tone="warning" className="ml-1">
                                      {f.versionType}
                                    </Badge>
                                  ) : null}
                                  <code className="block font-mono text-xs break-all text-muted-foreground">
                                    {f.destPath}
                                  </code>
                                  {f.replaces.length ? (
                                    <span className="block text-xs text-muted-foreground">
                                      Replaces {f.replaces.join(", ")}
                                    </span>
                                  ) : null}
                                </TableCell>
                                <TableCell className="text-xs">
                                  {f.reason === "requested"
                                    ? "Requested"
                                    : `${f.reason === "dependency" ? "Required" : "Optional"} by ${f.requiredBy.map(nameOf).join(", ")}`}
                                </TableCell>
                                <TableCell className="text-right text-xs whitespace-nowrap tabular">
                                  {formatBytes(f.sizeBytes)}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">Nothing to download.</p>
                    )}
                    {plan.alreadyInstalled.length ? (
                      <p className="text-xs text-muted-foreground">
                        Already installed: {plan.alreadyInstalled.map((a) => a.path).join(", ")}
                      </p>
                    ) : null}
                    {plan.optionalDependencies.length ? (
                      <fieldset className="flex flex-col gap-1">
                        <legend className="mb-1 text-sm font-medium">Optional dependencies</legend>
                        {plan.optionalDependencies.map((o) => {
                          const id = o.projectId ?? o.versionId;
                          if (!id) return null;
                          const label = o.title ?? o.slug ?? id;
                          return (
                            <label key={id} className="flex items-center gap-2 text-sm">
                              <Checkbox
                                checked={includeOptional.includes(id)}
                                disabled={locked}
                                onCheckedChange={(c) =>
                                  setOption(() =>
                                    setIncludeOptional((list) =>
                                      c === true ? [...new Set([...list, id])] : list.filter((x) => x !== id),
                                    ),
                                  )
                                }
                                aria-label={`Include ${label}`}
                              />
                              <span className="break-words">{label}</span>
                              <span className="text-xs text-muted-foreground">
                                wanted by {nameOf(o.requiredBy)}
                              </span>
                            </label>
                          );
                        })}
                      </fieldset>
                    ) : null}
                    {warnings
                      ? (["error", "warning", "info"] as const).map((level) =>
                          warnings[level].length ? (
                            <div key={level} className="flex flex-col gap-1">
                              <h4 className="text-xs font-semibold">{LEVEL_UI[level].title}</h4>
                              <ul className="flex flex-col gap-0.5 text-xs">
                                {warnings[level].map((w, i) => {
                                  const Icon = LEVEL_UI[level].icon;
                                  return (
                                    <li key={i} className="flex items-start gap-1">
                                      <Icon
                                        className={`mt-0.5 size-3.5 shrink-0 ${LEVEL_UI[level].className}`}
                                        aria-hidden
                                      />
                                      <span className="break-words">{w.message}</span>
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          ) : null,
                        )
                      : null}
                    {!plan.installable ? (
                      <Callout tone="danger">
                        This plan can't be installed: resolve the blocking problems above.
                      </Callout>
                    ) : plan.restartRequired ? (
                      <p className="text-xs text-muted-foreground">
                        The server is not stopped: the files take effect at the next start.
                      </p>
                    ) : null}
                    {tooMany ? (
                      <Callout tone="danger">
                        More than {MAX_EXPECT} files: install the dependencies separately first.
                      </Callout>
                    ) : null}
                  </section>
                ) : null}
              </>
            )}
          </>
        )}
        {installError ? (
          <p role="alert" className="text-sm text-danger">
            {installError.title}
            {uncertain ? " — the outcome is unknown; installing again retries the same request." : ""}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={install.isPending}>
            Close
          </Button>
          {canManage ? (
            <Button
              loading={install.isPending}
              disabled={!plan || !body || !plan.installable || plan.files.length === 0 || tooMany}
              onClick={() => body && install.mutate(body)}
            >
              {changedPlan ? "Confirm the new plan" : "Install"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
