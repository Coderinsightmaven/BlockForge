import { useQuery } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import { useState } from "react";
import { EXTENSION_UPDATE_PROBLEMS } from "@blockforge/contracts";
import type { ExtensionList, Server } from "@blockforge/contracts";
import { extensionsApi } from "@/lib/api/extensions-api";
import { useIdempotencyKeys } from "@/lib/idempotency";
import { useApiMutation } from "@/lib/mutations";
import { qk } from "@/lib/query-keys";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Timestamp } from "@/components/common/timestamp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { extensionNames } from "./extension-model";

/* Plugins & mods → Updates (its own chunk, loaded when the section is opened). */

export default function UpdatesSection({
  server,
  list,
  canManage,
  onJob,
}: {
  server: Server;
  list: ExtensionList;
  canManage: boolean;
  onJob: (jobId: string, title: string) => void;
}) {
  const [allowPrerelease, setAllowPrerelease] = useState(false);
  const [checked, setChecked] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const q = useQuery({
    queryKey: qk.server(server.id).extensionUpdates(allowPrerelease),
    queryFn: ({ signal }) => extensionsApi.updates(server.id, allowPrerelease, signal),
    enabled: checked,
    staleTime: 5 * 60_000,
  });
  const keys = useIdempotencyKeys<string>();
  const ids = [...selected].sort();
  const action = JSON.stringify([ids, allowPrerelease]);
  const apply = useApiMutation({
    mutationFn: (body: { extensionIds: string[]; allowPrerelease: boolean }) =>
      extensionsApi.applyUpdates(
        server.id,
        body,
        keys.sent(JSON.stringify([body.extensionIds, body.allowPrerelease])),
      ),
    success: "Updating",
    errorTitle: "Could not apply the updates",
    onError: (error, body) =>
      keys.settle(JSON.stringify([body.extensionIds, body.allowPrerelease]), { ok: false, error }),
    onSuccess: (r, body) => {
      keys.settle(JSON.stringify([body.extensionIds, body.allowPrerelease]), { ok: true });
      setSelected(new Set());
      onJob(r.jobId, `Updating ${body.extensionIds.length} extension(s)`);
    },
  });
  const locked = keys.isLocked(action);
  const byId = new Map(list.items.map((e) => [e.id, e]));
  const available = (q.data?.items ?? []).filter((u) => u.updateAvailable);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          loading={q.isFetching}
          onClick={() => (checked ? void q.refetch() : setChecked(true))}
        >
          <RefreshCw aria-hidden />
          Check for updates
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={allowPrerelease} onCheckedChange={setAllowPrerelease} disabled={locked} />
          Include beta/alpha versions
        </label>
        {q.data ? (
          <span className="text-xs text-muted-foreground">
            Checked <Timestamp ts={q.data.checkedAt} />
          </span>
        ) : null}
      </div>
      {allowPrerelease ? (
        <Callout tone="warning">
          Pre-release versions can be unstable or break worlds — back up first.
        </Callout>
      ) : null}
      {!checked ? (
        <p className="text-sm text-muted-foreground">
          Checks the Modrinth-identified extensions for newer compatible versions.
        </p>
      ) : q.isPending ? (
        <TableSkeleton columns={3} rows={3} />
      ) : q.isError ? (
        <ErrorState
          error={q.error}
          onRetry={() => void q.refetch()}
          title="Could not check for updates"
          compact
        />
      ) : available.length === 0 ? (
        <EmptyState
          icon={Download}
          title="Everything is up to date"
          description="Only Modrinth-identified files can be checked."
          compact
        />
      ) : (
        <>
          <ul className="flex flex-col divide-y rounded-md border">
            {available.map((u) => {
              const ext = byId.get(u.extensionId);
              const name = ext ? extensionNames(ext).join(", ") : u.path;
              const id = `upd-${u.extensionId}`;
              return (
                <li key={u.extensionId} className="flex items-center gap-3 p-3 text-sm">
                  {canManage ? (
                    <Checkbox
                      id={id}
                      checked={selected.has(u.extensionId)}
                      disabled={!u.file || locked}
                      onCheckedChange={(c) =>
                        setSelected((s) => {
                          const n = new Set(s);
                          if (c === true) n.add(u.extensionId);
                          else n.delete(u.extensionId);
                          return n;
                        })
                      }
                      aria-label={`Update ${name}`}
                    />
                  ) : null}
                  <label htmlFor={id} className="min-w-0 flex-1">
                    <span className="font-medium break-words">{name}</span>{" "}
                    <span className="text-muted-foreground tabular">
                      {u.current?.versionNumber ?? "?"} → {u.latest?.versionNumber ?? "?"}
                    </span>
                    {u.latest && u.latest.versionType !== "release" ? (
                      <Badge tone="warning" className="ml-1.5">
                        {u.latest.versionType}
                      </Badge>
                    ) : null}
                    {u.problem ? (
                      <span className="block text-xs text-danger">
                        Can't be applied: {EXTENSION_UPDATE_PROBLEMS[u.problem]}.
                      </span>
                    ) : null}
                  </label>
                </li>
              );
            })}
          </ul>
          {canManage ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={selected.size === 0}
                loading={apply.isPending}
                onClick={() => apply.mutate({ extensionIds: ids, allowPrerelease })}
              >
                Apply {selected.size || ""} update{selected.size === 1 ? "" : "s"}
              </Button>
              {locked ? (
                <span role="status" className="text-xs">
                  The previous request's outcome is unknown; applying again retries the same request.
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
