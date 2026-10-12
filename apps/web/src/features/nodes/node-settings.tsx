import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { UpdateNodeRequest } from "@blockforge/contracts";
import type { Node } from "@blockforge/contracts";
import type { z } from "zod";
import { nodesApi } from "@/lib/api/endpoints";
import { fieldErrorsFrom } from "@/lib/api/errors";
import { formatBytes, formatCores } from "@/lib/format";
import { useApiMutation } from "@/lib/mutations";
import { qk } from "@/lib/query-keys";
import { upsertNodeInCache } from "@/lib/realtime/handlers";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { parseTags } from "./node-utils";

const GIB = 1024 ** 3;
type Patch = z.input<typeof UpdateNodeRequest>;
type EditableStatus = NonNullable<Patch["status"]>;
const EDITABLE_STATUSES: EditableStatus[] = ["active", "draining", "maintenance", "disabled"];

export interface NodeForm {
  name: string;
  location: string;
  tags: string;
  publicAddress: string;
  privateAddress: string;
  schedulingEnabled: boolean;
  cpuCores: string;
  memoryGiB: string;
  storageGiB: string;
  overcommit: string;
  status: EditableStatus | null;
}

const trimNum = (n: number) => String(Math.round(n * 100) / 100);

export function formFromNode(node: Node): NodeForm {
  return {
    name: node.name,
    location: node.location ?? "",
    tags: node.tags.join(", "),
    publicAddress: node.publicAddress ?? "",
    privateAddress: node.privateAddress ?? "",
    schedulingEnabled: node.schedulingEnabled,
    cpuCores: trimNum(node.capacity.cpuAllocatableMillicores / 1000),
    memoryGiB: trimNum(node.capacity.memoryAllocatableBytes / GIB),
    storageGiB: trimNum(node.capacity.storageAllocatableBytes / GIB),
    overcommit: String(node.capacity.overcommitMemoryRatio),
    status: (EDITABLE_STATUSES as string[]).includes(node.status) ? (node.status as EditableStatus) : null,
  };
}

/**
 * Builds a minimal `UpdateNodeRequest` containing only changed fields, validated against the
 * contract. Returns field errors keyed by form field.
 */
export function buildNodePatch(node: Node, form: NodeForm): { patch: Patch; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const patch: Patch = {};
  const nullable = (s: string) => (s.trim() === "" ? null : s.trim());

  if (form.name.trim() !== node.name) patch.name = form.name.trim();
  if (nullable(form.location) !== node.location) patch.location = nullable(form.location);
  const tags = parseTags(form.tags);
  if (tags.error) errors.tags = tags.error;
  else if (tags.tags.join(",") !== node.tags.join(",")) patch.tags = tags.tags;
  if (nullable(form.publicAddress) !== node.publicAddress) patch.publicAddress = nullable(form.publicAddress);
  if (nullable(form.privateAddress) !== node.privateAddress)
    patch.privateAddress = nullable(form.privateAddress);
  if (form.schedulingEnabled !== node.schedulingEnabled) patch.schedulingEnabled = form.schedulingEnabled;

  const num = (key: keyof NodeForm, raw: string, label: string): number | null => {
    const v = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(v) || v < 0) {
      errors[key] = `Enter a non-negative number for ${label}.`;
      return null;
    }
    return v;
  };
  const cores = num("cpuCores", form.cpuCores, "CPU");
  if (cores !== null) {
    const mc = Math.round(cores * 1000);
    if (mc !== node.capacity.cpuAllocatableMillicores) patch.cpuAllocatableMillicores = mc;
  }
  const mem = num("memoryGiB", form.memoryGiB, "memory");
  if (mem !== null) {
    const b = Math.round(mem * GIB);
    if (Math.abs(b - node.capacity.memoryAllocatableBytes) >= GIB / 200) patch.memoryAllocatableBytes = b;
  }
  const sto = num("storageGiB", form.storageGiB, "storage");
  if (sto !== null) {
    const b = Math.round(sto * GIB);
    if (Math.abs(b - node.capacity.storageAllocatableBytes) >= GIB / 200) patch.storageAllocatableBytes = b;
  }
  const oc = Number(form.overcommit);
  if (!Number.isFinite(oc) || oc < 1 || oc > 4) errors.overcommit = "Use a ratio between 1 and 4.";
  else if (oc !== node.capacity.overcommitMemoryRatio) patch.overcommitMemoryRatio = oc;
  if (form.status && form.status !== node.status) patch.status = form.status;

  const parsed = UpdateNodeRequest.safeParse(patch);
  if (!parsed.success) {
    const map: Record<string, keyof NodeForm> = {
      cpuAllocatableMillicores: "cpuCores",
      memoryAllocatableBytes: "memoryGiB",
      storageAllocatableBytes: "storageGiB",
      overcommitMemoryRatio: "overcommit",
    };
    for (const issue of parsed.error.issues) {
      const k = String(issue.path[0] ?? "form");
      errors[map[k] ?? k] ??= issue.message;
    }
  }
  return { patch, errors };
}

export function NodeSettings({ node, canManage }: { node: Node; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<NodeForm>(() => formFromNode(node));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);

  // Follow server updates while the user has not started editing.
  useEffect(() => {
    if (!dirty) setForm(formFromNode(node));
  }, [node, dirty]);

  const save = useApiMutation({
    mutationFn: (patch: Patch) => nodesApi.update(node.id, patch),
    success: "Node settings saved",
    errorTitle: "Could not save node settings",
    invalidate: [qk.overview],
    onSuccess: (updated) => {
      upsertNodeInCache(queryClient, updated);
      setDirty(false);
    },
  });

  const set = <K extends keyof NodeForm>(k: K, v: NodeForm[K]) => {
    setDirty(true);
    setForm((f) => ({ ...f, [k]: v }));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const { patch, errors: errs } = buildNodePatch(node, form);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    if (Object.keys(patch).length === 0) {
      setDirty(false);
      return;
    }
    save.mutate(patch, { onError: (err) => setErrors(fieldErrorsFrom(err)) });
  };

  const physicalCores = node.facts?.cpuLogicalCores ?? null;
  const physicalMem = node.facts?.memoryTotalBytes ?? null;
  const memGiB = Number(form.memoryGiB);
  const oc = Number(form.overcommit) || 1;
  const overcommitted = physicalMem !== null && Number.isFinite(memGiB) && memGiB * GIB > physicalMem * oc;
  const disabled = !canManage || save.isPending;

  return (
    <form onSubmit={submit} noValidate>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Node settings</CardTitle>
            <CardDescription>
              Identity, placement and the capacity this node offers to BlockForge.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {!canManage ? (
            <Callout tone="info">
              You can view these settings but need the nodes.manage permission to change them.
            </Callout>
          ) : null}
          <fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2">
            <legend className="sr-only">Identity</legend>
            <Field label="Name" error={errors.name} required>
              <Input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={80} />
            </Field>
            <Field label="Location" error={errors.location} hint="Free text, e.g. a data centre or city.">
              <Input value={form.location} onChange={(e) => set("location", e.target.value)} maxLength={80} />
            </Field>
            <Field
              label="Tags"
              error={errors.tags}
              hint="Comma-separated; used for placement preferences."
              className="sm:col-span-2"
            >
              <Input value={form.tags} onChange={(e) => set("tags", e.target.value)} />
            </Field>
            <Field
              label="Public address"
              error={errors.publicAddress}
              hint="Hostname or IP players connect to."
            >
              <Input
                value={form.publicAddress}
                onChange={(e) => set("publicAddress", e.target.value)}
                maxLength={253}
                spellCheck={false}
              />
            </Field>
            <Field
              label="Private address"
              error={errors.privateAddress}
              hint="Address other nodes use (e.g. proxy → backend)."
            >
              <Input
                value={form.privateAddress}
                onChange={(e) => set("privateAddress", e.target.value)}
                maxLength={253}
                spellCheck={false}
              />
            </Field>
          </fieldset>

          <fieldset disabled={disabled} className="flex flex-col gap-4">
            <legend className="mb-2 text-sm font-semibold">Scheduling</legend>
            <label className="flex items-start gap-3">
              <Switch
                checked={form.schedulingEnabled}
                onCheckedChange={(v) => set("schedulingEnabled", v)}
                className="mt-0.5"
                disabled={disabled}
              />
              <span className="flex flex-col">
                <span className="text-sm font-medium">Place new servers on this node</span>
                <span className="text-xs text-muted-foreground">
                  Turning this off keeps existing servers running but excludes the node from automatic
                  placement.
                </span>
              </span>
            </label>
            {form.status ? (
              <Field
                label="Administrative status"
                error={errors.status}
                hint="Draining and maintenance stop new placements; disabled takes the node out of service."
              >
                <Select
                  value={form.status}
                  onValueChange={(v) => set("status", v)}
                  options={EDITABLE_STATUSES.map((s) => ({
                    value: s,
                    label: s[0]!.toUpperCase() + s.slice(1),
                  }))}
                  disabled={disabled}
                  className="max-w-xs"
                />
              </Field>
            ) : (
              <p className="text-xs text-muted-foreground">
                Status “{node.status}” is changed through the{" "}
                {node.status === "pending" ? "Approve" : "enrollment"} action, not here.
              </p>
            )}
          </fieldset>

          <fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <legend className="mb-2 text-sm font-semibold">Allocatable capacity</legend>
            <Field
              label="CPU (cores)"
              error={errors.cpuCores}
              hint={physicalCores ? `Host has ${formatCores(physicalCores)} (logical).` : undefined}
            >
              <Input
                type="number"
                min={0}
                step={0.25}
                inputMode="decimal"
                value={form.cpuCores}
                onChange={(e) => set("cpuCores", e.target.value)}
              />
            </Field>
            <Field
              label="Memory (GiB)"
              error={errors.memoryGiB}
              hint={physicalMem ? `Host has ${formatBytes(physicalMem)}.` : undefined}
            >
              <Input
                type="number"
                min={0}
                step={0.5}
                inputMode="decimal"
                value={form.memoryGiB}
                onChange={(e) => set("memoryGiB", e.target.value)}
              />
            </Field>
            <Field label="Storage (GiB)" error={errors.storageGiB}>
              <Input
                type="number"
                min={0}
                step={1}
                inputMode="decimal"
                value={form.storageGiB}
                onChange={(e) => set("storageGiB", e.target.value)}
              />
            </Field>
            <Field label="Memory overcommit" error={errors.overcommit} hint="1 = no overcommit; up to 4×.">
              <Input
                type="number"
                min={1}
                max={4}
                step={0.1}
                inputMode="decimal"
                value={form.overcommit}
                onChange={(e) => set("overcommit", e.target.value)}
              />
            </Field>
          </fieldset>
          {overcommitted ? (
            <Callout tone="warning" title="Exceeds physical memory">
              Allocatable memory is larger than the host's physical memory × overcommit ratio. Servers may be
              OOM-killed if they use their limits.
            </Callout>
          ) : null}
        </CardContent>
        {canManage ? (
          <CardFooter className="justify-end">
            <Button
              variant="outline"
              disabled={!dirty || save.isPending}
              onClick={() => {
                setForm(formFromNode(node));
                setErrors({});
                setDirty(false);
              }}
            >
              Discard changes
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!dirty}>
              Save
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </form>
  );
}
