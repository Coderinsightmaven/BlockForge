import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BellPlus, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { AlertRuleKind as AlertRuleKindSchema, UpsertAlertRuleRequest } from "@blockforge/contracts";
import type { AlertRule } from "@blockforge/contracts";
import type { z } from "zod";
import { alertsApi } from "@/lib/api/endpoints";
import { fieldErrorsFrom } from "@/lib/api/errors";
import { formatDuration } from "@/lib/format";
import { useApiMutation } from "@/lib/mutations";
import { alertRulesQuery, channelsQuery, nodesQuery } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Select } from "@/components/ui/select";
import { ALERT_SEVERITY_META, StatusBadge, statusMeta } from "@/components/ui/status";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RULE_KINDS, ruleKindMeta } from "./alert-meta";
import type { AlertRuleKind, RuleScope } from "./alert-meta";

type RuleBody = z.input<typeof UpsertAlertRuleRequest>;

function ruleToBody(r: AlertRule): RuleBody {
  const { id: _id, ...rest } = r;
  return rest;
}

function defaultBody(kind: AlertRuleKind = "node.cpu.high"): RuleBody {
  const meta = RULE_KINDS[kind];
  return {
    name: meta.label,
    kind,
    severity: "warning",
    enabled: true,
    scopeType: "global",
    scopeId: null,
    threshold: meta.threshold?.default ?? null,
    forSeconds: meta.defaultFor,
    cooldownSeconds: 900,
    channelIds: [],
  };
}

function RuleDialog({
  open,
  onOpenChange,
  rule,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  rule: AlertRule | null;
}) {
  const [body, setBody] = useState<RuleBody>(() => (rule ? ruleToBody(rule) : defaultBody()));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const nodes = useQuery({ ...nodesQuery, enabled: open });
  const channels = useQuery({ ...channelsQuery, enabled: open });
  useEffect(() => {
    if (open) {
      setBody(rule ? ruleToBody(rule) : defaultBody());
      setErrors({});
    }
  }, [open, rule]);

  const save = useApiMutation({
    mutationFn: (b: RuleBody) => (rule ? alertsApi.updateRule(rule.id, b) : alertsApi.createRule(b)),
    success: rule ? "Alert rule saved" : "Alert rule created",
    errorTitle: rule ? "Could not save rule" : "Could not create rule",
    invalidate: [qk.alerts.rules],
    onSuccess: () => onOpenChange(false),
  });

  const meta = ruleKindMeta(body.kind);
  const set = <K extends keyof RuleBody>(k: K, v: RuleBody[K]) => setBody((b) => ({ ...b, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const candidate: RuleBody = {
      ...body,
      name: body.name.trim(),
      threshold: meta.threshold ? body.threshold : null,
      scopeId: body.scopeType === "global" ? null : body.scopeId,
    };
    const next: Record<string, string> = {};
    if (!candidate.name) next.name = "Give the rule a name.";
    if (meta.threshold) {
      const t = candidate.threshold;
      if (
        t === null ||
        t === undefined ||
        !Number.isFinite(t) ||
        t < meta.threshold.min ||
        t > meta.threshold.max
      ) {
        next.threshold = `Enter a value between ${meta.threshold.min} and ${meta.threshold.max}.`;
      }
    }
    if (candidate.scopeType !== "global" && !candidate.scopeId)
      next.scopeId = "Choose what this rule applies to.";
    const parsed = UpsertAlertRuleRequest.safeParse(candidate);
    if (!parsed.success) for (const i of parsed.error.issues) next[String(i.path[0] ?? "form")] ??= i.message;
    setErrors(next);
    if (Object.keys(next).length || !parsed.success) return;
    save.mutate(parsed.data, { onError: (err) => setErrors(fieldErrorsFrom(err)) });
  };

  const scopeOptions: Array<{ value: RuleScope; label: string; disabled?: boolean }> = [
    { value: "global", label: "Everything I can access" },
    { value: "node", label: "A specific node", disabled: !meta.scopes.includes("node") },
    { value: "server", label: "A specific server (available in Phase 3)", disabled: true },
  ];

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-xl">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{rule ? "Edit alert rule" : "New alert rule"}</DialogTitle>
            <DialogDescription>{meta.description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Condition" error={errors.kind}>
              <Select
                value={body.kind}
                onValueChange={(k) => {
                  const m = RULE_KINDS[k];
                  setBody((b) => ({
                    ...b,
                    kind: k,
                    name: b.name === ruleKindMeta(b.kind).label || !b.name ? m.label : b.name,
                    threshold: m.threshold
                      ? ruleKindMeta(b.kind).threshold
                        ? b.threshold
                        : m.threshold.default
                      : null,
                    forSeconds: m.defaultFor,
                    scopeType: m.scopes.includes(b.scopeType) ? b.scopeType : "global",
                  }));
                }}
                options={AlertRuleKindSchema.options.map((k) => ({ value: k, label: RULE_KINDS[k].label }))}
              />
            </Field>
            <Field label="Name" error={errors.name} required>
              <Input value={body.name} onChange={(e) => set("name", e.target.value)} maxLength={120} />
            </Field>
            <Field label="Severity" error={errors.severity}>
              <Select
                value={body.severity}
                onValueChange={(v) => set("severity", v)}
                options={[
                  { value: "info", label: "Info" },
                  { value: "warning", label: "Warning" },
                  { value: "critical", label: "Critical" },
                ]}
              />
            </Field>
            {meta.threshold ? (
              <Field label={meta.threshold.label} hint={meta.threshold.hint} error={errors.threshold}>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={meta.threshold.min}
                  max={meta.threshold.max}
                  value={body.threshold ?? ""}
                  onChange={(e) => set("threshold", e.target.value === "" ? null : Number(e.target.value))}
                />
              </Field>
            ) : (
              <div />
            )}
            <Field label="Applies to" error={errors.scopeType}>
              <Select
                value={body.scopeType}
                onValueChange={(v) => setBody((b) => ({ ...b, scopeType: v, scopeId: null }))}
                options={scopeOptions}
              />
            </Field>
            {body.scopeType === "node" ? (
              <Field label="Node" error={errors.scopeId}>
                <Select
                  value={body.scopeId ?? undefined}
                  onValueChange={(v) => set("scopeId", v)}
                  placeholder={nodes.isPending ? "Loading nodes…" : "Choose a node"}
                  options={(nodes.data ?? []).map((n) => ({ value: n.id, label: n.name }))}
                />
              </Field>
            ) : (
              <div />
            )}
            <Field
              label="For (seconds)"
              hint={`Condition must hold this long before firing${body.forSeconds ? ` (${formatDuration(body.forSeconds * 1000)})` : ""}.`}
              error={errors.forSeconds}
            >
              <Input
                type="number"
                min={0}
                step={10}
                value={body.forSeconds}
                onChange={(e) => set("forSeconds", Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              />
            </Field>
            <Field
              label="Cooldown (seconds)"
              hint={`Minimum time between notifications${body.cooldownSeconds ? ` (${formatDuration(body.cooldownSeconds * 1000)})` : ""}.`}
              error={errors.cooldownSeconds}
            >
              <Input
                type="number"
                min={0}
                step={60}
                value={body.cooldownSeconds}
                onChange={(e) => set("cooldownSeconds", Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              />
            </Field>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs font-medium">Notify</legend>
            {channels.isPending ? (
              <p className="text-xs text-muted-foreground">Loading channels…</p>
            ) : channels.isError ? (
              <p className="text-xs text-danger">
                Could not load notification channels: {(channels.error as Error).message}
              </p>
            ) : (channels.data ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No notification channels yet; incidents will still appear in BlockForge.
              </p>
            ) : (
              (channels.data ?? []).map((c) => {
                const id = `rule-ch-${c.id}`;
                const checked = (body.channelIds ?? []).includes(c.id);
                return (
                  <div key={c.id} className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={checked}
                      onCheckedChange={(v) =>
                        set(
                          "channelIds",
                          v
                            ? [...(body.channelIds ?? []), c.id]
                            : (body.channelIds ?? []).filter((x) => x !== c.id),
                        )
                      }
                    />
                    <Label htmlFor={id} className="font-normal">
                      {c.name} <span className="text-muted-foreground">({c.kind})</span>
                    </Label>
                  </div>
                );
              })
            )}
          </fieldset>
          <label className="flex items-center gap-3">
            <Switch checked={body.enabled} onCheckedChange={(v) => set("enabled", v)} />
            <span className="text-sm">Enabled</span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {rule ? "Save rule" : "Create rule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EnabledToggle({ rule, disabled }: { rule: AlertRule; disabled: boolean }) {
  const queryClient = useQueryClient();
  const toggle = useApiMutation({
    mutationFn: (enabled: boolean) => alertsApi.updateRule(rule.id, { ...ruleToBody(rule), enabled }),
    success: (r) => (r.enabled ? `“${r.name}” enabled` : `“${r.name}” disabled`),
    errorTitle: "Could not update rule",
    onSuccess: (updated) => {
      queryClient.setQueryData<AlertRule[]>(qk.alerts.rules, (list) =>
        list?.map((r) => (r.id === updated.id ? updated : r)),
      );
    },
  });
  return (
    <Switch
      checked={toggle.isPending ? !rule.enabled : rule.enabled}
      disabled={disabled || toggle.isPending}
      onCheckedChange={(v) => toggle.mutate(v)}
      aria-label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
    />
  );
}

export function RulesTab({
  canManage,
  openCreate,
  onCreateHandled,
}: {
  canManage: boolean;
  openCreate?: boolean;
  onCreateHandled?: () => void;
}) {
  const rules = useQuery(alertRulesQuery);
  const nodes = useQuery(nodesQuery);
  const channels = useQuery({ ...channelsQuery, enabled: canManage });
  const [editing, setEditing] = useState<AlertRule | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<AlertRule | null>(null);
  const remove = useApiMutation({
    mutationFn: (id: string) => alertsApi.deleteRule(id),
    success: "Alert rule deleted",
    errorTitle: "Could not delete rule",
    invalidate: [qk.alerts.rules],
    onSuccess: () => setDeleting(null),
  });

  useEffect(() => {
    if (openCreate && canManage) {
      setEditing(null);
      setDialogOpen(true);
      onCreateHandled?.();
    }
  }, [openCreate, canManage, onCreateHandled]);

  const scopeLabel = (r: AlertRule) =>
    r.scopeType === "global"
      ? "All"
      : r.scopeType === "node"
        ? `Node: ${nodes.data?.find((n) => n.id === r.scopeId)?.name ?? r.scopeId}`
        : `Server: ${r.scopeId}`;
  const channelName = (id: string) => channels.data?.find((c) => c.id === id)?.name ?? "channel";

  return (
    <Card>
      <div className="flex items-center justify-between gap-2 border-b p-2.5">
        <p className="text-xs text-muted-foreground">
          Rules are evaluated by the control plane; repeated firings are deduplicated into one incident and
          notifications respect the cooldown.
        </p>
        {canManage ? (
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <BellPlus aria-hidden />
            New rule
          </Button>
        ) : null}
      </div>
      {rules.isPending ? (
        <TableSkeleton columns={6} />
      ) : rules.isError && !rules.data ? (
        <ErrorState
          error={rules.error}
          onRetry={() => void rules.refetch()}
          title="Could not load alert rules"
        />
      ) : (rules.data ?? []).length === 0 ? (
        <EmptyState
          icon={BellPlus}
          title="No alert rules"
          description="Create rules for CPU, memory, disk space or node reachability."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Enabled</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Condition</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Timing</TableHead>
              <TableHead>Channels</TableHead>
              {canManage ? (
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rules.data ?? []).map((r) => {
              const meta = ruleKindMeta(r.kind);
              return (
                <TableRow key={r.id}>
                  <TableCell>
                    <EnabledToggle rule={r} disabled={!canManage} />
                  </TableCell>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>
                    <StatusBadge meta={statusMeta(ALERT_SEVERITY_META, r.severity)} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {meta.label}
                    {meta.threshold && r.threshold !== null ? (
                      <div className="text-muted-foreground">
                        {meta.threshold.label.replace(" (%)", "")} {r.threshold}%
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs">{scopeLabel(r)}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    for {formatDuration(r.forSeconds * 1000)}
                    <div className="text-muted-foreground">
                      cooldown {formatDuration(r.cooldownSeconds * 1000)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {r.channelIds.length ? (
                        r.channelIds.map((id) => (
                          <Badge key={id} variant="outline">
                            {channelName(id)}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">In-app only</span>
                      )}
                    </div>
                  </TableCell>
                  {canManage ? (
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Edit ${r.name}`}
                          onClick={() => {
                            setEditing(r);
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil aria-hidden />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Delete ${r.name}`}
                          onClick={() => setDeleting(r)}
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {canManage ? <RuleDialog open={dialogOpen} onOpenChange={setDialogOpen} rule={editing} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete alert rule?"
        description={`“${deleting?.name ?? ""}” stops being evaluated. Existing incidents remain in the history.`}
        confirmLabel="Delete rule"
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </Card>
  );
}
