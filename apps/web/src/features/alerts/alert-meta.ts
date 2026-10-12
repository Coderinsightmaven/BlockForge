import { ALERT_RULE_KINDS } from "@blockforge/contracts";
import type { AlertRule } from "@blockforge/contracts";

export type AlertRuleKind = AlertRule["kind"];
export type RuleScope = AlertRule["scopeType"];

export interface RuleKindMeta {
  label: string;
  /** From the contract (`ALERT_RULE_KINDS`): what the evaluator actually checks. */
  description: string;
  /** null = the rule takes no threshold (contract unit `null`; the API requires `threshold: null`). */
  threshold: { label: string; hint: string; default: number; min: number; max: number } | null;
  scopes: RuleScope[];
  defaultFor: number;
}

type ThresholdUi = NonNullable<RuleKindMeta["threshold"]>;

/** Presentation only; semantics (description, whether a threshold exists) come from the contract. */
const UI: Record<
  AlertRuleKind,
  { label: string; threshold?: ThresholdUi; scopes: RuleScope[]; defaultFor: number }
> = {
  "node.cpu.high": {
    label: "Node CPU high",
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
    threshold: {
      label: "Memory used above (%)",
      hint: "(total − available) ÷ total, so reclaimable cache does not count as used.",
      default: 90,
      min: 1,
      max: 100,
    },
    scopes: ["global", "node"],
    defaultFor: 300,
  },
  "node.disk.low": {
    label: "Node disk space low",
    threshold: {
      label: "Free space below (%)",
      hint: "Fires when any filesystem has less than this share free (10 = under 10 % free).",
      default: 10,
      min: 1,
      max: 99,
    },
    scopes: ["global", "node"],
    defaultFor: 60,
  },
  "node.unreachable": { label: "Node unreachable", scopes: ["global", "node"], defaultFor: 60 },
  "server.crashed": { label: "Server crashed", scopes: ["global", "node", "server"], defaultFor: 0 },
  "server.memory.high": {
    label: "Server memory high",
    threshold: {
      label: "Memory above (% of limit)",
      hint: "Container memory ÷ its configured limit.",
      default: 90,
      min: 1,
      max: 100,
    },
    scopes: ["global", "node", "server"],
    defaultFor: 300,
  },
  "server.heap.high": {
    label: "Java heap high",
    threshold: {
      label: "Heap above (% of max)",
      hint: "Heap used ÷ heap max (-Xmx).",
      default: 90,
      min: 1,
      max: 100,
    },
    scopes: ["global", "node", "server"],
    defaultFor: 300,
  },
  "job.failed": { label: "Job failed", scopes: ["global", "node", "server"], defaultFor: 0 },
};

export const RULE_KINDS = Object.fromEntries(
  (Object.keys(UI) as AlertRuleKind[]).map((kind) => {
    const contract = ALERT_RULE_KINDS[kind];
    const ui = UI[kind];
    const meta: RuleKindMeta = {
      label: ui.label,
      description: contract.description,
      threshold: contract.unit === null ? null : (ui.threshold ?? null),
      scopes: ui.scopes,
      defaultFor: ui.defaultFor,
    };
    return [kind, meta];
  }),
) as Record<AlertRuleKind, RuleKindMeta>;

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
