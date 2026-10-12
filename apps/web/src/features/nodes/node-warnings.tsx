import { TriangleAlert } from "lucide-react";
import type { Node } from "@blockforge/contracts";
import { Timestamp } from "@/components/common/timestamp";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";

export type NodeWarning = Node["warnings"][number];

/** Agent warning codes (agent-protocol §5.1) with what an operator should do about them. */
export const NODE_WARNING_META: Record<string, { label: string; hint: string }> = {
  CLOCK_SKEW: {
    label: "Clock out of sync",
    hint: "The node's clock differs from the control plane by more than 15 s. Enable NTP (e.g. systemd-timesyncd); signed commands and timestamps depend on it.",
  },
  SFTP_UNAVAILABLE: {
    label: "SFTP unavailable",
    hint: "The agent could not start its SFTP listener (port in use or permission problem). File transfers over SFTP to this node will fail.",
  },
  INSTALL_OWNERSHIP: {
    label: "Install file ownership",
    hint: "After an interrupted install the agent could not restore file ownership; affected servers may fail to write their files. Reinstall them or fix ownership on the node.",
  },
  WORKLOAD_RESTART_LIMIT: {
    label: "Restart limit reached",
    hint: "A server crashed repeatedly and its restart policy gave up. Check its console and start it manually.",
  },
};

export function warningMeta(code: string): { label: string; hint: string | null } {
  return NODE_WARNING_META[code] ?? { label: code, hint: null };
}

/** Active agent warnings on the node page (messages from the agent are rendered as text). */
export function NodeWarnings({ warnings }: { warnings: readonly NodeWarning[] }) {
  if (warnings.length === 0) return null;
  const sorted = [...warnings].sort((a, b) => b.at - a.at);
  return (
    <Callout
      tone="warning"
      title={`${warnings.length} agent warning${warnings.length === 1 ? "" : "s"}`}
      className="mb-4"
    >
      <ul className="flex flex-col gap-2">
        {sorted.map((w) => {
          const meta = warningMeta(w.code);
          return (
            <li key={w.code} className="flex flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2 text-foreground">
                <span className="font-medium">{meta.label}</span>
                <code className="font-mono text-[11px] text-muted-foreground">{w.code}</code>
                <Timestamp ts={w.at} className="text-xs text-muted-foreground" />
              </span>
              <span className="break-words">{w.message}</span>
              {meta.hint ? <span className="text-xs">{meta.hint}</span> : null}
            </li>
          );
        })}
      </ul>
    </Callout>
  );
}

/** Compact badge for lists. */
export function NodeWarningBadge({ warnings }: { warnings: readonly NodeWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <Badge
      tone="warning"
      title={warnings.map((w) => `${warningMeta(w.code).label}: ${w.message}`).join("\n")}
    >
      <TriangleAlert aria-hidden />
      {warnings.length} warning{warnings.length === 1 ? "" : "s"}
    </Badge>
  );
}
