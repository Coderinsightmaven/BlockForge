import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AlertIncident,
  AlertSeverity,
  AuditEvent,
  JobStatus,
  NodeConnection,
  NodeStatus,
  ServerState,
  User,
} from "@blockforge/contracts";
import {
  ALERT_SEVERITY_META,
  AUDIT_OUTCOME_META,
  INCIDENT_STATUS_META,
  JOB_STATUS_META,
  NODE_CONNECTION_META,
  NODE_STATUS_META,
  NodeConnectionBadge,
  NodeStatusBadge,
  SERVER_STATE_META,
  ServerStateBadge,
  USER_STATUS_META,
  statusMeta,
} from "./status";
import type { StatusMeta } from "./status";

const TONES = new Set(["success", "warning", "danger", "info", "neutral"]);

function expectComplete(name: string, values: readonly string[], map: Record<string, StatusMeta>) {
  it(`${name}: maps every enum value to a label, tone, icon and description`, () => {
    expect(Object.keys(map).sort()).toEqual([...values].sort());
    for (const v of values) {
      const meta = map[v]!;
      expect(meta.label.trim(), v).not.toBe("");
      expect(TONES.has(meta.tone), v).toBe(true);
      expect(meta.icon, v).toBeTruthy();
      expect(meta.description.trim(), v).not.toBe("");
    }
    // Labels are distinct so state is never conveyed by colour alone.
    expect(new Set(values.map((v) => map[v]!.label)).size).toBe(values.length);
  });
}

describe("status mappings", () => {
  expectComplete("ServerState", ServerState.options, SERVER_STATE_META);
  expectComplete("NodeConnection", NodeConnection.options, NODE_CONNECTION_META);
  expectComplete("NodeStatus", NodeStatus.options, NODE_STATUS_META);
  expectComplete("AlertSeverity", AlertSeverity.options, ALERT_SEVERITY_META);
  expectComplete("Incident status", AlertIncident.shape.status.options, INCIDENT_STATUS_META);
  expectComplete("JobStatus", JobStatus.options, JOB_STATUS_META);
  expectComplete("Audit outcome", AuditEvent.shape.outcome.options, AUDIT_OUTCOME_META);
  expectComplete("User status", User.shape.status.options, USER_STATUS_META);

  it("falls back gracefully for values newer than this build", () => {
    const meta = statusMeta(SERVER_STATE_META, "hibernating");
    expect(meta.label).toBe("hibernating");
    expect(meta.tone).toBe("neutral");
  });
});

describe("status badges", () => {
  it.each(ServerState.options)("renders server state %s with its label and an icon", (state) => {
    const { container } = render(<ServerStateBadge state={state} />);
    expect(screen.getByText(SERVER_STATE_META[state].label)).toBeTruthy();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it.each(NodeConnection.options)("renders node connection %s", (connection) => {
    render(<NodeConnectionBadge connection={connection} />);
    expect(screen.getByText(NODE_CONNECTION_META[connection].label)).toBeTruthy();
  });

  it.each(NodeStatus.options)("renders node status %s", (status) => {
    render(<NodeStatusBadge status={status} />);
    expect(screen.getByText(NODE_STATUS_META[status].label)).toBeTruthy();
  });
});
