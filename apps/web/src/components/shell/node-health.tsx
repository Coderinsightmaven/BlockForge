import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Server, TriangleAlert } from "lucide-react";
import type { Me, Node } from "@blockforge/contracts";
import { canAny } from "@/lib/permissions";
import { nodesQuery } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { toneClass } from "@/components/ui/badge";
import type { Tone } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";

export interface NodeHealthSummary {
  total: number;
  online: number;
  degraded: number;
  down: number;
  pending: number;
  /** Nodes with at least one active agent warning (clock skew, SFTP down, …). */
  withWarnings: number;
  tone: Tone;
}

/** Revoked nodes are excluded; nodes intentionally disabled are not counted as "down". */
export function summarizeNodeHealth(nodes: readonly Node[]): NodeHealthSummary {
  const relevant = nodes.filter((n) => n.status !== "revoked");
  const expectedUp = relevant.filter(
    (n) => n.status === "active" || n.status === "draining" || n.status === "maintenance",
  );
  const online = relevant.filter((n) => n.connection === "online").length;
  const degraded = expectedUp.filter((n) => n.connection === "degraded").length;
  const down = expectedUp.filter((n) => n.connection === "unreachable" || n.connection === "offline").length;
  const pending = relevant.filter((n) => n.status === "pending").length;
  const withWarnings = relevant.filter((n) => n.warnings.length > 0).length;
  const tone: Tone =
    relevant.length === 0
      ? "neutral"
      : down > 0
        ? "danger"
        : degraded > 0 || pending > 0 || withWarnings > 0
          ? "warning"
          : "success";
  return { total: relevant.length, online, degraded, down, pending, withWarnings, tone };
}

export function NodeHealthIndicator({ me }: { me: Me | undefined }) {
  const enabled = canAny(me, "nodes.view");
  const { data, isError } = useQuery({ ...nodesQuery, enabled });
  if (!enabled) return null;
  const s = data ? summarizeNodeHealth(data) : null;
  const detail = !s
    ? isError
      ? "Node status could not be loaded."
      : "Loading node status…"
    : s.total === 0
      ? "No nodes enrolled yet."
      : `${s.online} online · ${s.degraded} degraded · ${s.down} unreachable/offline · ${s.pending} pending approval` +
        (s.withWarnings ? ` · ${s.withWarnings} with agent warnings` : "");
  return (
    <Tooltip content={detail}>
      <Link
        to="/nodes"
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-accent",
          toneClass[s?.tone ?? "neutral"],
        )}
        aria-label={`Nodes: ${detail}`}
      >
        <Server className="size-4 text-tone" aria-hidden />
        <span className="tabular font-medium">{s ? `${s.online}/${s.total}` : "–/–"}</span>
        <span className="hidden text-muted-foreground md:inline">online</span>
        {s?.withWarnings ? (
          <TriangleAlert className="size-3.5 text-warning" aria-label={`${s.withWarnings} with warnings`} />
        ) : null}
      </Link>
    </Tooltip>
  );
}
