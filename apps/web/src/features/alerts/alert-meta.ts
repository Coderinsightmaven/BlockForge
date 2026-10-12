import type { AlertRule } from "@blockforge/contracts";

export type AlertRuleKind = AlertRule["kind"];
export type RuleScope = AlertRule["scopeType"];

export interface RuleKindMeta {
  label: string;
  description: string;
  /** null = the rule has no numeric threshold. */
  threshold: { label: string; hint: string; default: number; min: number; max: number } | null;
  scopes: RuleScope[];
  defaultFor: number;
}

/**
 * Threshold semantics per kind as presented to users. NOTE: the contract does not yet document
 * units/direction; these assume percentages (see contract change requests).
 */
export const RULE_KINDS: Record<AlertRuleKind, RuleKindMeta> = {
  "node.cpu.high": {
    label: "Node CPU high",
    description: "Host CPU utilisation stays above the threshold.",
    threshold: {
      label: "CPU usage above (%)",
      hint: "Whole-host utilisation, 0–100.",
      default: 90,
      min: 1,
      max: 100,
    },
    scopes: ["global", "node"],
    defaultFor: 300,
  },
  "node.memory.high": {
    label: "Node memory high",
    description: "Host memory in use stays above the threshold.",
    threshold: {
      label: "Memory used above (%)",
      hint: "Used ÷ total physical memory.",
      default: 90,
      min: 1,
      max: 100,
    },
    scopes: ["global", "node"],
    defaultFor: 300,
  },
  "node.disk.low": {
    label: "Node disk space low",
    description: "Free space on a node filesystem drops below the threshold.",
    threshold: {
      label: "Free space below (%)",
      hint: "Evaluated per filesystem.",
      default: 10,
      min: 1,
      max: 99,
    },
    scopes: ["global", "node"],
    defaultFor: 60,
  },
  "node.unreachable": {
    label: "Node unreachable",
    description: "The agent stops sending heartbeats.",
    threshold: null,
    scopes: ["global", "node"],
    defaultFor: 60,
  },
  "server.crashed": {
    label: "Server crashed",
    description: "A Minecraft server process exits unexpectedly.",
    threshold: null,
    scopes: ["global", "node", "server"],
    defaultFor: 0,
  },
  "server.memory.high": {
    label: "Server memory high",
    description: "A server's container memory approaches its limit.",
    threshold: {
      label: "Memory above (% of limit)",
      hint: "Container memory ÷ configured limit.",
      default: 90,
      min: 1,
      max: 100,
    },
    scopes: ["global", "node", "server"],
    defaultFor: 300,
  },
  "server.heap.high": {
    label: "Java heap high",
    description: "JVM heap usage approaches the maximum heap.",
    threshold: { label: "Heap above (% of max)", hint: "Heap used ÷ -Xmx.", default: 90, min: 1, max: 100 },
    scopes: ["global", "node", "server"],
    defaultFor: 300,
  },
  "job.failed": {
    label: "Job failed",
    description: "A background job (provisioning, backup, update…) fails.",
    threshold: null,
    scopes: ["global", "node", "server"],
    defaultFor: 0,
  },
};

export function ruleKindMeta(kind: string): RuleKindMeta {
  return (
    (RULE_KINDS as Record<string, RuleKindMeta>)[kind] ?? {
      label: kind,
      description: "",
      threshold: null,
      scopes: ["global"],
      defaultFor: 0,
    }
  );
}
