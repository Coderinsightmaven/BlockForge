import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Check, ExternalLink, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { softwareKind } from "@blockforge/contracts";
import type { ArtifactPlan, Me, ServerSoftware, TemplateSummary } from "@blockforge/contracts";
import { allocationsApi, serversApi } from "@/lib/api/servers-api";
import type { PlacementPreviewBody } from "@/lib/api/servers-api";
import { newIdempotencyKey } from "@/lib/api/client";
import { describeError, isApiError } from "@/lib/api/errors";
import { formatBytes } from "@/lib/format";
import { useApiMutation } from "@/lib/mutations";
import { canAny, hasGlobal } from "@/lib/permissions";
import {
  buildsQuery,
  planQuery,
  softwareQuery,
  templateQuery,
  templatesQuery,
  usersQuery,
  versionsQuery,
} from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { upsertServerInCache } from "@/lib/server-cache";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { VariableInput } from "../variable-input";
import {
  STEP_LABELS,
  WIZARD_STEPS,
  buildCreateBody,
  eggNeedsEula,
  firstInvalidStep,
  initialWizardState,
  isBuiltinTemplate,
  slugify,
  validateStep,
  validateWizard,
  variableEditable,
} from "./wizard-state";
import type { GameplayForm, WizardContext, WizardState, WizardStep } from "./wizard-state";

type Set_ = (patch: Partial<WizardState>) => void;

function Stepper({
  step,
  reached,
  onGo,
}: {
  step: WizardStep;
  reached: number;
  onGo: (s: WizardStep) => void;
}) {
  return (
    <ol className="mb-4 flex flex-wrap items-center gap-1.5 text-xs" aria-label="Steps">
      {WIZARD_STEPS.map((s, i) => {
        const active = s === step;
        const done = i < WIZARD_STEPS.indexOf(step);
        return (
          <li key={s} className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={i > reached}
              aria-current={active ? "step" : undefined}
              onClick={() => onGo(s)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 disabled:opacity-50",
                active && "border-primary bg-primary text-primary-foreground",
                done && !active && "border-success/40",
              )}
            >
              {done ? <Check className="size-3.5" aria-hidden /> : <span className="tabular">{i + 1}</span>}
              {STEP_LABELS[s]}
            </button>
            {i < WIZARD_STEPS.length - 1 ? <span className="h-px w-3 bg-border" aria-hidden /> : null}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------------------------

function TemplateStep({
  s,
  set,
  errors,
  templates,
}: {
  s: WizardState;
  set: Set_;
  errors: Record<string, string>;
  templates: TemplateSummary[];
}) {
  const groups = useMemo(() => {
    const m = new Map<string, TemplateSummary[]>();
    for (const t of templates) m.set(t.category, [...(m.get(t.category) ?? []), t]);
    return [...m].sort(([a], [b]) => (a === "Minecraft" ? -1 : b === "Minecraft" ? 1 : a.localeCompare(b)));
  }, [templates]);
  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold">What do you want to run?</legend>
        {errors.templateId ? <p className="text-xs text-danger">{errors.templateId}</p> : null}
        {groups.map(([cat, items]) => (
          <div key={cat} className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">{cat}</h3>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label={cat}>
              {items.map((t) => {
                const on = s.templateId === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() =>
                      set({
                        templateId: t.id,
                        software:
                          t.kind === "velocity"
                            ? "velocity"
                            : t.kind === "minecraft"
                              ? s.software === "velocity"
                                ? null
                                : s.software
                              : null,
                        version: null,
                        build: null,
                        dockerImage: t.dockerImages[0]?.image ?? null,
                        variables: {},
                        // Consent is per template; never carry it over silently.
                        acceptEula: s.templateId === t.id ? s.acceptEula : false,
                        memoryMiB: t.kind === "velocity" ? "1024" : t.kind === "minecraft" ? "4096" : "2048",
                      })
                    }
                    className={cn(
                      "flex flex-col gap-1 rounded-lg border p-3 text-left hover:bg-accent",
                      on && "border-primary ring-1 ring-primary",
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {t.name}
                      {t.kind !== "egg" ? (
                        <Badge tone="info">Built-in</Badge>
                      ) : (
                        <Badge variant="outline">Egg</Badge>
                      )}
                    </span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">
                      {t.description || "No description."}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Server name" error={errors.name} required>
          <Input
            value={s.name}
            maxLength={80}
            onChange={(e) =>
              set({ name: e.target.value, ...(s.slugTouched ? {} : { slug: slugify(e.target.value) }) })
            }
          />
        </Field>
        <Field
          label="Identifier"
          error={errors.slug}
          hint="Lowercase, used in paths and container names."
          required
        >
          <Input
            value={s.slug}
            maxLength={48}
            onChange={(e) => set({ slug: e.target.value.toLowerCase(), slugTouched: true })}
            className="font-mono"
            spellCheck={false}
          />
        </Field>
        <Field label="Description" className="sm:col-span-2">
          <Textarea
            value={s.description}
            onChange={(e) => set({ description: e.target.value })}
            maxLength={1024}
            rows={2}
          />
        </Field>
      </div>
    </div>
  );
}

function GameplayFields({
  g,
  set,
  errors,
}: {
  g: GameplayForm;
  set: (p: Partial<GameplayForm>) => void;
  errors: Record<string, string>;
}) {
  const sw = (k: "onlineMode" | "whitelist" | "pvp" | "hardcore", label: string, hint: string) => (
    <label className="flex items-start gap-3 rounded-md border p-2.5">
      <Switch checked={g[k]} onCheckedChange={(v) => set({ [k]: v })} className="mt-0.5" />
      <span className="flex flex-col">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
  return (
    <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <legend className="mb-2 text-sm font-semibold">Gameplay</legend>
      <Field label="Message of the day" error={errors.motd} className="sm:col-span-2 lg:col-span-3">
        <Input value={g.motd} onChange={(e) => set({ motd: e.target.value })} maxLength={256} />
      </Field>
      <Field label="Max players" error={errors.maxPlayers}>
        <Input
          type="number"
          min={1}
          max={10000}
          value={g.maxPlayers}
          onChange={(e) => set({ maxPlayers: e.target.value })}
        />
      </Field>
      <Field label="Difficulty">
        <Select
          value={g.difficulty}
          onValueChange={(v) => set({ difficulty: v })}
          options={(["peaceful", "easy", "normal", "hard"] as const).map((v) => ({
            value: v,
            label: v[0]!.toUpperCase() + v.slice(1),
          }))}
        />
      </Field>
      <Field label="Game mode">
        <Select
          value={g.gamemode}
          onValueChange={(v) => set({ gamemode: v })}
          options={(["survival", "creative", "adventure", "spectator"] as const).map((v) => ({
            value: v,
            label: v[0]!.toUpperCase() + v.slice(1),
          }))}
        />
      </Field>
      <Field label="View distance (chunks)" error={errors.viewDistance}>
        <Input
          type="number"
          min={2}
          max={32}
          value={g.viewDistance}
          onChange={(e) => set({ viewDistance: e.target.value })}
        />
      </Field>
      <Field label="Simulation distance (chunks)" error={errors.simulationDistance}>
        <Input
          type="number"
          min={2}
          max={32}
          value={g.simulationDistance}
          onChange={(e) => set({ simulationDistance: e.target.value })}
        />
      </Field>
      <Field label="World seed" error={errors.levelSeed} hint="Empty = random.">
        <Input value={g.levelSeed} onChange={(e) => set({ levelSeed: e.target.value })} maxLength={64} />
      </Field>
      {sw("onlineMode", "Online mode", "Verify accounts with Mojang (turn off only behind a proxy).")}
      {sw("whitelist", "Whitelist", "Only listed players can join.")}
      {sw("pvp", "PvP", "Players can damage each other.")}
      {sw("hardcore", "Hardcore", "Permanent death; difficulty locked to hard.")}
    </fieldset>
  );
}

function MinecraftConfigure({
  s,
  set,
  errors,
  template,
  advanced,
}: {
  s: WizardState;
  set: Set_;
  errors: Record<string, string>;
  template: TemplateSummary;
  advanced: boolean;
}) {
  const software = useQuery(softwareQuery);
  const [showUnstable, setShowUnstable] = useState(false);
  const versions = useQuery({ ...versionsQuery(s.software ?? ""), enabled: !!s.software });
  const builds = useQuery({
    ...buildsQuery(s.software ?? "", s.version ?? ""),
    enabled: !!s.software && !!s.version,
  });
  const wantKind = template.kind === "velocity" ? "proxy" : "game";
  const options = (software.data ?? []).filter((x) => x.kind === wantKind);
  const versionList = (versions.data ?? []).filter((v) => showUnstable || v.channel === "release");
  const selectedVersion = versions.data?.find((v) => v.minecraftVersion === s.version);
  const game = !!s.software && softwareKind(s.software) === "game";

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">Server software</legend>
        {errors.software ? <p className="text-xs text-danger">{errors.software}</p> : null}
        {software.isPending ? (
          <Skeleton className="h-24" />
        ) : software.isError ? (
          <ErrorState
            error={software.error}
            onRetry={() => void software.refetch()}
            title="Could not load the catalogue"
            compact
          />
        ) : (
          <div
            className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
            role="radiogroup"
            aria-label="Server software"
          >
            {options.map((o) => {
              const on = s.software === o.software;
              return (
                <button
                  key={o.software}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => set({ software: o.software as ServerSoftware, version: null, build: null })}
                  className={cn(
                    "flex flex-col gap-1 rounded-lg border p-3 text-left hover:bg-accent",
                    on && "border-primary ring-1 ring-primary",
                  )}
                >
                  <span className="text-sm font-medium">{o.displayName}</span>
                  <span className="line-clamp-3 text-xs text-muted-foreground">{o.description}</span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {o.supportsPlugins ? <Badge variant="outline">Plugins</Badge> : null}
                    {o.supportsMods ? <Badge variant="outline">Mods</Badge> : null}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {s.software
          ? options
              .find((o) => o.software === s.software)
              ?.restrictions.map((r) => (
                <Callout key={r} tone="warning">
                  {r}
                </Callout>
              ))
          : null}
      </fieldset>

      {s.software ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Version"
            error={errors.version}
            hint={versions.isError ? describeError(versions.error).title : undefined}
          >
            <Select
              value={s.version ?? undefined}
              onValueChange={(v) => set({ version: v, build: null })}
              placeholder={versions.isPending ? "Loading versions…" : "Choose a version"}
              disabled={versions.isPending || versions.isError}
              options={versionList.map((v) => ({
                value: v.minecraftVersion,
                label: `${v.minecraftVersion}${v.channel !== "release" ? ` (${v.channel})` : ""}${v.support === "deprecated" ? " — deprecated" : ""}`,
              }))}
            />
          </Field>
          <Field label="Build" hint="Latest stable is resolved when the server is created.">
            <Select
              value={s.build ?? "__latest"}
              onValueChange={(v) => set({ build: v === "__latest" ? null : v })}
              disabled={!s.version || builds.isPending}
              options={[
                { value: "__latest", label: "Latest stable" },
                ...(builds.data ?? []).slice(0, 50).map((b) => ({
                  value: b.build,
                  label: `${b.build}${b.channel !== "stable" ? ` (${b.channel})` : ""}`,
                })),
              ]}
            />
          </Field>
          <label className="flex items-center gap-2 text-xs sm:col-span-2">
            <Switch checked={showUnstable} onCheckedChange={setShowUnstable} />
            Show snapshots, betas and experimental versions
          </label>
          {selectedVersion ? (
            <p className="text-xs text-muted-foreground sm:col-span-2">
              Runs on Java {selectedVersion.javaMajor ?? "?"}
              {selectedVersion.javaSource ? ` (from ${selectedVersion.javaSource} metadata)` : ""}.
              {selectedVersion.notes.map((n) => ` ${n}`)}
            </p>
          ) : null}
        </div>
      ) : null}

      {advanced ? (
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold">Java (advanced)</legend>
          <Field label="JVM flag preset" hint="Aikar's flags tune G1GC for Minecraft servers.">
            <Select
              value={s.jvmPreset}
              onValueChange={(v) => set({ jvmPreset: v })}
              options={[
                { value: "default", label: "BlockForge default" },
                { value: "aikar", label: "Aikar's flags" },
                { value: "none", label: "None (only my flags)" },
              ]}
            />
          </Field>
          <Field
            label="Java version override"
            error={errors.javaMajor}
            hint="Empty = what the version needs."
          >
            <Input
              inputMode="numeric"
              value={s.javaMajor}
              onChange={(e) => set({ javaMajor: e.target.value })}
              placeholder="auto"
            />
          </Field>
          <Field
            label="Extra JVM flags"
            error={errors.jvmArgs}
            hint="One per line, e.g. -Dfile.encoding=UTF-8. The heap is set on the Resources step."
            className="sm:col-span-2"
          >
            <Textarea
              value={s.jvmArgs}
              onChange={(e) => set({ jvmArgs: e.target.value })}
              rows={3}
              className="font-mono text-xs"
              spellCheck={false}
            />
          </Field>
        </fieldset>
      ) : null}

      {game ? (
        <GameplayFields
          g={s.gameplay}
          set={(p) => set({ gameplay: { ...s.gameplay, ...p } })}
          errors={errors}
        />
      ) : null}

      {game ? (
        <EulaCheckbox
          checked={s.acceptEula}
          onChange={(v) => set({ acceptEula: v })}
          error={errors.acceptEula}
        />
      ) : null}
    </div>
  );
}

/** The Mojang EULA acknowledgement, shared by the built-in template and `eula`-feature eggs. */
export function EulaCheckbox({
  checked,
  onChange,
  error,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  error?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3 rounded-md border p-3">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(c) => onChange(c === true)}
        className="mt-0.5"
        aria-invalid={!!error}
      />
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id} className="text-sm">
          I accept the Minecraft End User License Agreement
        </Label>
        <a
          href="https://aka.ms/MinecraftEULA"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          Read the EULA <ExternalLink className="size-3" aria-hidden />
        </a>
        {error ? <p className="text-xs text-danger">{error}</p> : null}
      </div>
    </div>
  );
}

function EggConfigure({
  s,
  set,
  errors,
  template,
  ctx,
}: {
  s: WizardState;
  set: Set_;
  errors: Record<string, string>;
  template: TemplateSummary;
  ctx: WizardContext;
}) {
  const baseId = useId();
  const vars = [...template.variables].sort((a, b) => a.sortOrder - b.sortOrder);
  return (
    <div className="flex flex-col gap-5">
      {template.dockerImages.length > 0 ? (
        <Field
          label="Docker image"
          error={errors.dockerImage}
          hint="Images must be on each node's agent allowlist."
        >
          <Select
            value={s.dockerImage ?? undefined}
            onValueChange={(v) => set({ dockerImage: v })}
            options={template.dockerImages.map((d) => ({ value: d.image, label: `${d.label} — ${d.image}` }))}
          />
        </Field>
      ) : null}
      {vars.length === 0 ? (
        <p className="text-sm text-muted-foreground">This template has no variables to set.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {vars.map((v) => {
            const id = `${baseId}-${v.envName}`;
            const err = errors[`var.${v.envName}`] ?? errors[`egg.variables.${v.envName}`];
            return (
              <div key={v.envName} className="flex flex-col gap-1.5 rounded-md border p-3">
                <Label htmlFor={id} className="text-sm">
                  {v.name}{" "}
                  <code className="ml-1 font-mono text-[11px] font-normal text-muted-foreground">
                    {v.envName}
                  </code>
                </Label>
                <VariableInput
                  id={id}
                  rules={v.rules}
                  value={s.variables[v.envName] ?? v.defaultValue}
                  onChange={(val) => set({ variables: { ...s.variables, [v.envName]: val } })}
                  disabled={!variableEditable(v, ctx)}
                  invalid={!!err}
                />
                {err ? <p className="text-xs text-danger">{err}</p> : null}
                {v.description ? (
                  <p className="text-xs whitespace-pre-line text-muted-foreground">{v.description}</p>
                ) : null}
                {!v.userEditable ? (
                  <p className="text-[11px] text-muted-foreground">
                    {ctx.admin
                      ? "Not user-editable — you can set it as an administrator."
                      : "Fixed by the template."}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {eggNeedsEula(template) ? (
        <EulaCheckbox
          checked={s.acceptEula}
          onChange={(v) => set({ acceptEula: v })}
          error={errors.acceptEula ?? errors["egg.acceptEula"]}
        />
      ) : null}
    </div>
  );
}

function usePlacementPreview(body: PlacementPreviewBody | null) {
  const [debounced, setDebounced] = useState(body);
  const key = JSON.stringify(body);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(body), 400);
    return () => clearTimeout(t);
    // `key` is the body's content; the object identity changes on every render.
  }, [key]);
  return useQuery({
    queryKey: qk.servers.placement(debounced),
    queryFn: ({ signal }) => serversApi.placementPreview(debounced!, signal),
    enabled: !!debounced,
    staleTime: 10_000,
    retry: false,
  });
}

function PlacementStep({
  me,
  s,
  set,
  errors,
  template,
}: {
  me: Me;
  s: WizardState;
  set: Set_;
  errors: Record<string, string>;
  template: TemplateSummary;
}) {
  const memory = Math.round(Number(s.memoryMiB) * 1024 ** 2);
  const body: PlacementPreviewBody | null = Number.isFinite(memory)
    ? {
        templateId: template.id,
        memoryLimitBytes: memory,
        cpuLimitMillicores: s.cpuCores.trim() ? Math.round(Number(s.cpuCores) * 1000) : null,
        storageQuotaBytes: s.diskGiB.trim() ? Math.round(Number(s.diskGiB) * 1024 ** 3) : null,
        placement:
          s.placementMode === "node" && s.nodeId
            ? { mode: "node", nodeId: s.nodeId }
            : { mode: "auto", preferTags: s.preferTags.split(/[\s,]+/).filter(Boolean) },
      }
    : null;
  const preview = usePlacementPreview(body);
  const candidates = [...(preview.data?.candidates ?? [])].sort(
    (a, b) => Number(b.fits) - Number(a.fits) || b.score - a.score,
  );
  const best = candidates.find((c) => c.fits);
  const allocNode = s.placementMode === "node" ? s.nodeId : null;
  const canListAllocations = canAny(me, "nodes.view");
  const allocs = useInfiniteQuery({
    queryKey: [...qk.nodes.allocations(allocNode ?? "", "free"), "wizard"],
    queryFn: ({ pageParam, signal }) =>
      allocationsApi.listForNode(allocNode!, { free: true, limit: 200, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (l) => l.nextCursor,
    enabled: !!allocNode && s.allocationMode === "specific" && canListAllocations,
  });
  const freeAllocs = allocs.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">Where should it run?</legend>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Placement">
          {(
            [
              ["auto", "Pick the best node for me"],
              ["node", "A specific node"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={s.placementMode === m}
              onClick={() =>
                set({
                  placementMode: m,
                  ...(m === "auto" ? { nodeId: null, allocationMode: "auto", allocationId: null } : {}),
                })
              }
              className={cn(
                "rounded-md border px-3 py-2 text-sm hover:bg-accent",
                s.placementMode === m && "border-primary ring-1 ring-primary",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {s.placementMode === "auto" ? (
          <Field label="Prefer nodes tagged" hint="Optional, comma-separated (soft preference).">
            <Input
              value={s.preferTags}
              onChange={(e) => set({ preferTags: e.target.value })}
              placeholder="eu, ssd"
            />
          </Field>
        ) : null}
        {errors.nodeId ? <p className="text-xs text-danger">{errors.nodeId}</p> : null}
      </fieldset>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Nodes</CardTitle>
            <CardDescription>
              Capacity check for {formatBytes(memory)} memory
              {s.placementMode === "auto" && best ? ` — would be placed on ${best.nodeName}` : ""}.
            </CardDescription>
          </div>
        </CardHeader>
        {preview.isPending && body ? (
          <CardContent>
            <Skeleton className="h-20" />
          </CardContent>
        ) : preview.isError ? (
          <ErrorState
            error={preview.error}
            onRetry={() => void preview.refetch()}
            title="Could not check placement"
            compact
          />
        ) : candidates.length === 0 ? (
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No nodes are available to you. An administrator must enroll a node first.
            </p>
          </CardContent>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Node</TableHead>
                <TableHead>Fits</TableHead>
                <TableHead>Free allocations</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidates.map((c) => {
                const chosen = s.placementMode === "node" && s.nodeId === c.nodeId;
                return (
                  <TableRow key={c.nodeId} data-state={chosen ? "selected" : undefined}>
                    <TableCell>
                      {s.placementMode === "node" ? (
                        <label className="flex items-center gap-2">
                          <input
                            type="radio"
                            name="placement-node"
                            checked={chosen}
                            disabled={!c.fits}
                            onChange={() => set({ nodeId: c.nodeId, allocationId: null })}
                          />
                          <span className="font-medium">{c.nodeName}</span>
                        </label>
                      ) : (
                        <span className="font-medium">
                          {c.nodeName}
                          {best?.nodeId === c.nodeId ? (
                            <Badge tone="info" className="ml-2">
                              Best
                            </Badge>
                          ) : null}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {c.fits ? <Badge tone="success">Fits</Badge> : <Badge tone="danger">Doesn't fit</Badge>}
                    </TableCell>
                    <TableCell className="tabular">{c.freeAllocations}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {c.reasons.length ? c.reasons.join("; ") : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">Primary allocation (IP:port)</legend>
        <div className="flex flex-wrap gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="alloc-mode"
              checked={s.allocationMode === "auto"}
              onChange={() => set({ allocationMode: "auto", allocationId: null })}
            />
            First free allocation on the node
          </label>
          <label
            className={cn(
              "flex items-center gap-2 text-sm",
              (s.placementMode !== "node" || !canListAllocations) && "opacity-50",
            )}
          >
            <input
              type="radio"
              name="alloc-mode"
              checked={s.allocationMode === "specific"}
              disabled={s.placementMode !== "node" || !s.nodeId || !canListAllocations}
              onChange={() => set({ allocationMode: "specific" })}
            />
            A specific one{" "}
            {s.placementMode !== "node"
              ? "(choose a node first)"
              : !canListAllocations
                ? "(needs node view access)"
                : ""}
          </label>
        </div>
        {s.allocationMode === "specific" ? (
          allocs.isPending ? (
            <Skeleton className="h-8 max-w-sm" />
          ) : allocs.isError ? (
            <p className="text-xs text-danger">{describeError(allocs.error).title}</p>
          ) : (
            <div className="max-w-sm">
              <Select
                value={s.allocationId ?? undefined}
                onValueChange={(v) => set({ allocationId: v })}
                placeholder={freeAllocs.length ? "Choose an allocation" : "No free allocations on this node"}
                disabled={freeAllocs.length === 0}
                aria-invalid={!!errors.allocationId}
                options={freeAllocs.map((a) => ({
                  value: a.id,
                  label: `${a.alias ?? a.ip}:${a.port}${a.notes ? ` — ${a.notes}` : ""}`,
                }))}
              />
            </div>
          )
        ) : null}
        {errors.allocationId ? <p className="text-xs text-danger">{errors.allocationId}</p> : null}
      </fieldset>
    </div>
  );
}

function ResourcesStep({
  me,
  s,
  set,
  errors,
  template,
  advanced,
}: {
  me: Me;
  s: WizardState;
  set: Set_;
  errors: Record<string, string>;
  template: TemplateSummary;
  advanced: boolean;
}) {
  const isAdmin = canAny(me, "servers.admin") && hasGlobal(me, "users.view");
  const users = useInfiniteQuery({ ...usersQuery, enabled: isAdmin });
  const userOptions = users.data?.pages.flatMap((p) => p.items) ?? [];
  const presets = [1024, 2048, 4096, 8192];
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field
          label="Memory limit (MiB)"
          error={errors.memoryMiB ?? errors.memoryLimitBytes}
          hint={
            isBuiltinTemplate(template)
              ? "Java uses ~80 % of this as heap; the rest is JVM overhead."
              : undefined
          }
          labelAddon={
            <span className="ml-auto flex gap-1">
              {presets.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="rounded border px-1 text-[11px] hover:bg-accent"
                  onClick={() => set({ memoryMiB: String(p) })}
                >
                  {p / 1024} GiB
                </button>
              ))}
            </span>
          }
        >
          <Input
            type="number"
            min={256}
            step={256}
            value={s.memoryMiB}
            onChange={(e) => set({ memoryMiB: e.target.value })}
          />
        </Field>
        <Field
          label="CPU limit (cores)"
          error={errors.cpuCores ?? errors.cpuLimitMillicores}
          hint="Empty = no limit (shares the node)."
        >
          <Input
            type="number"
            min={0.25}
            step={0.25}
            value={s.cpuCores}
            onChange={(e) => set({ cpuCores: e.target.value })}
            placeholder="unlimited"
          />
        </Field>
        <Field
          label="Disk quota (GiB)"
          error={errors.diskGiB ?? errors.storageQuotaBytes}
          hint="Empty = no quota."
        >
          <Input
            type="number"
            min={1}
            step={1}
            value={s.diskGiB}
            onChange={(e) => set({ diskGiB: e.target.value })}
            placeholder="none"
          />
        </Field>
        <Field
          label="Additional allocations"
          error={errors.allocationLimit}
          hint="Extra ports users may add later."
        >
          <Input
            type="number"
            min={0}
            max={50}
            value={s.allocationLimit}
            onChange={(e) => set({ allocationLimit: e.target.value })}
          />
        </Field>
        <Field label="Backup limit" error={errors.backupLimit}>
          <Input
            type="number"
            min={0}
            max={100}
            value={s.backupLimit}
            onChange={(e) => set({ backupLimit: e.target.value })}
          />
        </Field>
        <Field label="Start">
          <Select
            value={s.startup}
            onValueChange={(v) => set({ startup: v })}
            options={[
              { value: "auto", label: "Start after install and with the node" },
              { value: "manual", label: "Only when started manually" },
            ]}
          />
        </Field>
        {isBuiltinTemplate(template) && advanced ? (
          <Field
            label="Max heap (MiB)"
            error={errors.heapMiB ?? errors["minecraft.heapMaxBytes"]}
            hint="Empty = automatic (~80 % of the memory limit)."
          >
            <Input
              type="number"
              min={128}
              step={128}
              value={s.heapMiB}
              onChange={(e) => set({ heapMiB: e.target.value })}
              placeholder="auto"
            />
          </Field>
        ) : null}
        {isAdmin ? (
          <Field
            label="Owner"
            error={errors.ownerId}
            hint="Creating a server for someone else requires server administration rights."
          >
            <Select
              value={s.ownerId ?? me.user.id}
              onValueChange={(v) => set({ ownerId: v === me.user.id ? null : v })}
              options={[
                { value: me.user.id, label: `${me.user.displayName} (you)` },
                ...userOptions
                  .filter((u) => u.id !== me.user.id)
                  .map((u) => ({ value: u.id, label: `${u.displayName} (${u.username})` })),
              ]}
            />
          </Field>
        ) : null}
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function ArtifactPlanView({ plan }: { plan: ArtifactPlan }) {
  const tlsOnly = plan.downloads.filter((d) => !d.agentChecksum);
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Build</dt>
          <dd className="font-mono text-xs">
            {plan.software} {plan.version} · {plan.build} ({plan.channel})
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Java</dt>
          <dd>
            Java {plan.java.major} <span className="text-xs text-muted-foreground">({plan.java.source})</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Provenance</dt>
          <dd className="text-xs break-words">{plan.provenance}</dd>
        </div>
      </dl>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>File</TableHead>
            <TableHead>Downloaded from</TableHead>
            <TableHead>Integrity</TableHead>
            <TableHead className="text-right">Size</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {plan.downloads.map((d) => (
            <TableRow key={`${d.role}-${d.destPath}`}>
              <TableCell className="text-xs">
                <span className="font-mono">{d.destPath}</span>
                <span className="block text-muted-foreground">{d.role}</span>
              </TableCell>
              <TableCell className="font-mono text-xs">{hostOf(d.url)}</TableCell>
              <TableCell className="text-xs">
                {d.agentChecksum ? (
                  <span className="inline-flex items-center gap-1">
                    <ShieldCheck className="size-3.5 text-success" aria-hidden />
                    {d.agentChecksum.algorithm.toUpperCase()} verified by the agent
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <ShieldAlert className="size-3.5 text-warning" aria-hidden />
                    TLS only
                    {d.checksum?.algorithm === "md5"
                      ? " (upstream publishes MD5 only; not enforced)"
                      : " (no checksum published)"}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-right text-xs">{formatBytes(d.sizeBytes)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {tlsOnly.length ? (
        <Callout tone="warning" title="Some files are protected by TLS only">
          The upstream does not publish a strong checksum for {tlsOnly.map((d) => d.destPath).join(", ")}. The
          agent still only downloads over HTTPS from hosts on its{" "}
          <code className="font-mono">downloadHostAllowlist</code>.
        </Callout>
      ) : null}
      {plan.install.kind === "installer" ? (
        <Callout tone="info" title="Runs an installer">
          The server's installer runs once before the first start
          {plan.install.requiresNetwork ? " and needs internet access" : ""}.
          {plan.install.notes.map((n) => ` ${n}`)}
        </Callout>
      ) : null}
      {plan.requiresNetworkAtFirstStart ? (
        <Callout tone="info">
          The first start downloads additional libraries; the node needs internet access.
        </Callout>
      ) : null}
      {[...plan.java.notes, ...plan.notes].map((n) => (
        <p key={n} className="text-xs text-muted-foreground">
          {n}
        </p>
      ))}
    </div>
  );
}

function ReviewRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-1.5 text-sm sm:grid-cols-[12rem_1fr]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function ReviewStep({
  s,
  template,
  errors,
}: {
  s: WizardState;
  template: TemplateSummary;
  errors: Record<string, string>;
}) {
  const builtin = isBuiltinTemplate(template);
  const plan = useQuery({
    ...planQuery(s.software ?? "", s.version ?? "", s.build ?? "latest"),
    enabled: builtin && !!s.software && !!s.version,
  });
  const mem = Number(s.memoryMiB) * 1024 ** 2;
  return (
    <div className="flex flex-col gap-4">
      {Object.keys(errors).length ? (
        <Callout tone="danger" title="Fix these before creating">
          <ul className="list-disc pl-4">
            {Object.entries(errors).map(([k, m]) => (
              <li key={k}>
                <code className="font-mono text-xs">{k}</code>: {m}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <ReviewRow label="Name">
              {s.name} <code className="ml-1 font-mono text-xs text-muted-foreground">{s.slug}</code>
            </ReviewRow>
            <ReviewRow label="Template">{template.name}</ReviewRow>
            {builtin ? (
              <ReviewRow label="Software">
                {s.software} {s.version} · {s.build ?? "latest stable"} · {s.jvmPreset} JVM flags
              </ReviewRow>
            ) : (
              <ReviewRow label="Image">
                <code className="font-mono text-xs">{s.dockerImage ?? "template default"}</code>
              </ReviewRow>
            )}
            <ReviewRow label="Placement">
              {s.placementMode === "auto" ? "Automatic" : "Specific node"} ·{" "}
              {s.allocationMode === "auto" ? "first free port" : "chosen allocation"}
            </ReviewRow>
            <ReviewRow label="Resources">
              {formatBytes(mem)} memory · {s.cpuCores ? `${s.cpuCores} cores` : "no CPU limit"} ·{" "}
              {s.diskGiB ? `${s.diskGiB} GiB disk` : "no disk quota"}
            </ReviewRow>
            <ReviewRow label="Limits">
              {s.allocationLimit} extra allocation(s) · {s.backupLimit} backup(s)
            </ReviewRow>
          </dl>
        </CardContent>
      </Card>
      {builtin ? (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>What will be downloaded</CardTitle>
              <CardDescription>
                Resolved from the catalogue now; the agent verifies each file before it is used.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {plan.isPending ? (
              <Skeleton className="h-28" />
            ) : plan.isError ? (
              <ErrorState
                error={plan.error}
                onRetry={() => void plan.refetch()}
                title="Could not resolve the build"
                compact
              />
            ) : plan.data ? (
              <ArtifactPlanView plan={plan.data} />
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function CreateServerPage({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const templates = useQuery(templatesQuery);
  const [s, setState] = useState<WizardState>(initialWizardState);
  const [step, setStep] = useState<WizardStep>("template");
  const [reached, setReached] = useState(0);
  const [advanced, setAdvanced] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set: Set_ = (patch) => {
    setState((prev) => ({ ...prev, ...patch }));
    setErrors({});
  };
  const ctx = useMemo<WizardContext>(() => ({ admin: canAny(me, "servers.admin") }), [me]);
  const summary = templates.data?.find((t) => t.id === s.templateId) ?? null;
  // Template summaries only list user-viewable variables; administrators who can read templates
  // get the complete variable list so they can set every value (the API accepts it from them).
  const detail = useQuery({
    ...templateQuery(summary?.id ?? ""),
    enabled: !!summary && summary.kind === "egg" && ctx.admin && hasGlobal(me, "templates.view"),
  });
  const template = useMemo(
    () => (summary && detail.data ? { ...summary, variables: detail.data.variables } : summary),
    [summary, detail.data],
  );
  const idx = WIZARD_STEPS.indexOf(step);

  const full = useMemo(() => validateWizard(s, template, ctx), [s, template, ctx]);
  // One key per distinct request: retries of the same body are deduplicated by the API.
  const bodyKey = useMemo(
    () => (template ? JSON.stringify(buildCreateBody(s, template, ctx)) : ""),
    [s, template, ctx],
  );
  // A new key only when the request body changes; resubmitting the same body reuses it.
  const idempotencyKey = useMemo(() => (bodyKey ? newIdempotencyKey() : ""), [bodyKey]);

  const create = useApiMutation({
    mutationFn: () => {
      if (!full.body) throw new Error("The form is not complete.");
      return serversApi.create(full.body, idempotencyKey);
    },
    success: (r) => `${r.server.name} is being created`,
    errorTitle: "Could not create the server",
    onError: (err) => {
      if (isApiError(err) && err.code === "VALIDATION_FAILED") {
        const issues =
          (err.details as { issues?: Array<{ path: string; message: string }> } | undefined)?.issues ?? [];
        if (issues.length) setErrors(Object.fromEntries(issues.map((i) => [i.path || "form", i.message])));
      }
    },
    onSuccess: async (r) => {
      upsertServerInCache(queryClient, r.server);
      await queryClient.invalidateQueries({ queryKey: qk.servers.lists });
      await navigate({ to: "/servers/$serverId", params: { serverId: r.server.id } });
    },
  });

  const go = (target: WizardStep) => {
    setErrors({});
    setStep(target);
  };
  const next = () => {
    const e = validateStep(step, s, template, ctx);
    if (Object.keys(e).length) {
      setErrors(e);
      return;
    }
    const n = WIZARD_STEPS[idx + 1];
    if (n) {
      setReached((r) => Math.max(r, idx + 1));
      go(n);
    }
  };
  const submit = () => {
    if (!full.body) {
      const bad = firstInvalidStep(full.errors);
      if (bad && bad !== "review") {
        go(bad);
        setErrors(full.errors[bad] ?? {});
      }
      return;
    }
    create.mutate();
  };

  if (templates.isPending) return <Skeleton className="h-96 w-full" />;
  if (templates.isError)
    return (
      <ErrorState
        error={templates.error}
        onRetry={() => void templates.refetch()}
        title="Could not load templates"
      />
    );
  if (templates.data.length === 0) {
    return (
      <EmptyState
        title="No templates available"
        description="An administrator needs to import a template (egg) before servers can be created."
        action={
          <Button asChild variant="outline">
            <Link to="/servers">Back to servers</Link>
          </Button>
        }
      />
    );
  }

  const stepErrors = step === "review" ? Object.assign({}, ...Object.values(full.errors)) : errors;

  return (
    <>
      <Link
        to="/servers"
        className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Servers
      </Link>
      <PageHeader
        title="Create server"
        actions={
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={advanced} onCheckedChange={setAdvanced} />
            Advanced options
          </label>
        }
      />
      <Stepper step={step} reached={reached} onGo={go} />
      <Card>
        <CardContent className="pt-4">
          {step === "template" ? (
            <TemplateStep s={s} set={set} errors={stepErrors} templates={templates.data} />
          ) : null}
          {step === "configure" && template ? (
            isBuiltinTemplate(template) ? (
              <MinecraftConfigure
                s={s}
                set={set}
                errors={stepErrors}
                template={template}
                advanced={advanced}
              />
            ) : (
              <EggConfigure s={s} set={set} errors={stepErrors} template={template} ctx={ctx} />
            )
          ) : null}
          {step === "placement" && template ? (
            <PlacementStep me={me} s={s} set={set} errors={stepErrors} template={template} />
          ) : null}
          {step === "resources" && template ? (
            <ResourcesStep
              me={me}
              s={s}
              set={set}
              errors={stepErrors}
              template={template}
              advanced={advanced}
            />
          ) : null}
          {step === "review" && template ? (
            <ReviewStep s={s} template={template} errors={{ ...stepErrors, ...errors }} />
          ) : null}
        </CardContent>
      </Card>
      <div className="mt-3 flex items-center justify-between gap-2">
        <Button
          variant="outline"
          disabled={idx === 0 || create.isPending}
          onClick={() => go(WIZARD_STEPS[idx - 1]!)}
        >
          <ArrowLeft aria-hidden />
          Back
        </Button>
        {step === "review" ? (
          <Button onClick={submit} loading={create.isPending} disabled={!full.body}>
            Create server
          </Button>
        ) : (
          <Button onClick={next}>
            Next
            <ArrowRight aria-hidden />
          </Button>
        )}
      </div>
    </>
  );
}
