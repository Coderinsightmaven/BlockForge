import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Filter, ScrollText, ShieldCheck, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { AuditEvent, Me } from "@blockforge/contracts";
import { auditApi } from "@/lib/api/endpoints";
import type { AuditFilters } from "@/lib/api/endpoints";
import { describeError } from "@/lib/api/errors";
import { formatNumber, formatTimestamp } from "@/lib/format";
import { hasGlobal } from "@/lib/permissions";
import { auditQuery, usersQuery } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { fromLocalInputValue } from "@/components/charts/time-range-picker";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, NoPermission, TableSkeleton } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { AUDIT_OUTCOME_META, StatusBadge, statusMeta } from "@/components/ui/status";
import { TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SpacerRow, VirtualTable, useVirtualRows } from "@/components/ui/virtual-table";

const ANY = "__any";

interface FilterForm {
  action: string;
  actorId: string;
  targetType: string;
  targetId: string;
  from: string;
  to: string;
}
const EMPTY: FilterForm = { action: "", actorId: ANY, targetType: "", targetId: "", from: "", to: "" };

export function toAuditFilters(f: FilterForm): { filters: AuditFilters; error: string | null } {
  const filters: AuditFilters = {};
  if (f.action.trim()) filters.action = f.action.trim();
  if (f.actorId && f.actorId !== ANY && f.actorId.trim()) filters.actorId = f.actorId.trim();
  if (f.targetType.trim()) filters.targetType = f.targetType.trim();
  if (f.targetId.trim()) filters.targetId = f.targetId.trim();
  const from = f.from ? fromLocalInputValue(f.from) : undefined;
  const to = f.to ? fromLocalInputValue(f.to) : undefined;
  if (from !== undefined && Number.isFinite(from)) filters.from = from;
  if (to !== undefined && Number.isFinite(to)) filters.to = to;
  if (filters.from !== undefined && filters.to !== undefined && filters.from >= filters.to) {
    return { filters, error: "“From” must be before “To”." };
  }
  return { filters, error: null };
}

function actorLabel(e: AuditEvent): string {
  if (e.actorType === "system") return "System";
  return e.actorName ?? e.actorId ?? e.actorType;
}

function VerifyChain() {
  const q = useQuery({
    queryKey: qk.audit.verify,
    queryFn: ({ signal }) => auditApi.verify(signal),
    enabled: false,
    retry: false,
    gcTime: 0,
  });
  return (
    <div className="flex flex-col items-end gap-2">
      <Button variant="outline" loading={q.isFetching} onClick={() => void q.refetch()}>
        <ShieldCheck aria-hidden />
        Verify chain
      </Button>
      <div aria-live="polite" className="max-w-md">
        {q.isError ? (
          <Callout tone="danger" title="Verification could not run">
            {describeError(q.error).title}
          </Callout>
        ) : q.data ? (
          q.data.valid ? (
            <Callout tone="success" title="Audit chain intact">
              {formatNumber(q.data.checked, 0)} events checked; every record's hash links to its predecessor.
            </Callout>
          ) : (
            <Callout tone="danger" title="Audit chain broken" role="alert">
              {formatNumber(q.data.checked, 0)} events checked. The chain breaks at event{" "}
              <span className="font-mono break-all">{q.data.firstBrokenId ?? "unknown"}</span>: a record was
              altered, removed or inserted outside BlockForge. Treat this as a security incident.
            </Callout>
          )
        ) : null}
      </div>
    </div>
  );
}

export function AuditPage({ me }: { me: Me }) {
  const allowed = hasGlobal(me, "audit.view");
  const canUsers = hasGlobal(me, "users.view");
  const [form, setForm] = useState<FilterForm>(EMPTY);
  const [applied, setApplied] = useState<AuditFilters>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const users = useInfiniteQuery({ ...usersQuery, enabled: allowed && canUsers });
  const q = useInfiniteQuery({ ...auditQuery(applied), enabled: allowed });

  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  // Pages accumulate as the user loads older events; only visible rows are mounted.
  const virtual = useVirtualRows(items, { estimateSize: 49, getKey: (e) => e.id });
  if (!allowed) return <NoPermission what="view the audit log" />;
  const userOptions = users.data?.pages.flatMap((p) => p.items) ?? [];
  const set = (k: keyof FilterForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const apply = (e: FormEvent) => {
    e.preventDefault();
    const { filters, error } = toAuditFilters(form);
    setFormError(error);
    if (!error) setApplied(filters);
  };
  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const activeCount = Object.keys(applied).length;

  return (
    <>
      <PageHeader
        title="Audit Logs"
        description="Tamper-evident record of administrative actions. Newest first."
        actions={<VerifyChain />}
      />
      <Card className="mb-3">
        <form onSubmit={apply} className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-6" noValidate>
          <Field label="Action" hint="Exact action, e.g. node.revoke">
            <Input value={form.action} onChange={(e) => set("action")(e.target.value)} spellCheck={false} />
          </Field>
          <Field label="Actor">
            {canUsers ? (
              <Select
                value={form.actorId}
                onValueChange={set("actorId")}
                options={[
                  { value: ANY, label: "Anyone" },
                  ...userOptions.map((u) => ({ value: u.id, label: u.displayName })),
                ]}
              />
            ) : (
              <Input
                value={form.actorId === ANY ? "" : form.actorId}
                onChange={(e) => set("actorId")(e.target.value)}
                placeholder="Actor ID"
                spellCheck={false}
              />
            )}
          </Field>
          <Field label="Target type" hint="e.g. node, user">
            <Input
              value={form.targetType}
              onChange={(e) => set("targetType")(e.target.value)}
              spellCheck={false}
            />
          </Field>
          <Field label="Target ID">
            <Input
              value={form.targetId}
              onChange={(e) => set("targetId")(e.target.value)}
              spellCheck={false}
            />
          </Field>
          <Field label="From">
            <Input type="datetime-local" value={form.from} onChange={(e) => set("from")(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="datetime-local" value={form.to} onChange={(e) => set("to")(e.target.value)} />
          </Field>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-6">
            <Button type="submit" size="sm">
              <Filter aria-hidden />
              Apply filters
            </Button>
            {activeCount ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setForm(EMPTY);
                  setApplied({});
                  setFormError(null);
                }}
              >
                <X aria-hidden />
                Clear ({activeCount})
              </Button>
            ) : null}
            {formError ? (
              <span role="alert" className="text-xs text-danger">
                {formError}
              </span>
            ) : null}
          </div>
        </form>
      </Card>
      <Card>
        {q.isPending ? (
          <TableSkeleton columns={6} rows={8} />
        ) : q.isError && !q.data ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load the audit log" />
        ) : items.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="No audit events"
            description={
              activeCount ? "Nothing matches these filters." : "Administrative actions will be recorded here."
            }
          />
        ) : (
          <>
            <VirtualTable scrollRef={virtual.scrollRef} rowCount={items.length}>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow className="hover:bg-transparent" aria-rowindex={1}>
                  <TableHead className="w-8">
                    <span className="sr-only">Details</span>
                  </TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <tbody>
                <SpacerRow height={virtual.padTop} colSpan={7} />
              </tbody>
              {virtual.items.map((vi) => {
                const e = items[vi.index]!;
                const open = expanded.has(e.id);
                const hasDetails = Object.keys(e.details).length > 0;
                return (
                  // One measured <tbody> per event so an expanded details row moves with it.
                  <tbody
                    key={vi.key}
                    ref={virtual.virtualizer.measureElement}
                    data-index={vi.index}
                    className="border-b"
                  >
                    <TableRow aria-rowindex={vi.index + 2} className="border-0">
                      <TableCell className="px-1">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-expanded={open}
                          aria-controls={`audit-${e.id}`}
                          aria-label={open ? "Hide details" : "Show details"}
                          onClick={() => toggle(e.id)}
                        >
                          {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
                        </Button>
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{formatTimestamp(e.at)}</TableCell>
                      <TableCell className="text-xs">
                        <div>{actorLabel(e)}</div>
                        <div className="text-muted-foreground">{e.actorType}</div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{e.action}</TableCell>
                      <TableCell className="max-w-56 text-xs">
                        {e.targetType ? (
                          <>
                            <div>{e.targetType}</div>
                            <div
                              className="truncate font-mono text-muted-foreground"
                              title={e.targetId ?? undefined}
                            >
                              {e.targetId}
                            </div>
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge meta={statusMeta(AUDIT_OUTCOME_META, e.outcome)} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{e.ip ?? "—"}</TableCell>
                    </TableRow>
                    {open ? (
                      <TableRow id={`audit-${e.id}`} className="bg-muted/30 hover:bg-muted/30">
                        <TableCell />
                        <TableCell colSpan={6}>
                          <dl className="mb-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
                            <div>
                              <dt className="text-muted-foreground">Event ID</dt>
                              <dd className="font-mono break-all">{e.id}</dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground">Request ID</dt>
                              <dd className="font-mono break-all">{e.requestId ?? "—"}</dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground">Actor ID</dt>
                              <dd className="font-mono break-all">{e.actorId ?? "—"}</dd>
                            </div>
                          </dl>
                          {hasDetails ? (
                            // Rendered as text: details may contain user-controlled strings.
                            <pre className="max-h-80 overflow-auto rounded-md border bg-card p-2 font-mono text-xs whitespace-pre-wrap break-all">
                              {JSON.stringify(e.details, null, 2)}
                            </pre>
                          ) : (
                            <p className="text-xs text-muted-foreground">No additional details.</p>
                          )}
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </tbody>
                );
              })}
              <tbody>
                <SpacerRow height={virtual.padBottom} colSpan={7} />
              </tbody>
            </VirtualTable>
            {q.hasNextPage ? (
              <div className="flex justify-center border-t p-2">
                <Button
                  size="sm"
                  variant="outline"
                  loading={q.isFetchingNextPage}
                  onClick={() => void q.fetchNextPage()}
                >
                  Load older events
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </>
  );
}
