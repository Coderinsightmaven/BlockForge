import { TOPIC_PATTERNS } from "@blockforge/contracts";
import { authorize, hasPermissionAnywhere, type Principal } from "../rbac/authorize.js";
import type { RbacService } from "../rbac/service.js";

export interface TopicDeps {
  rbac: RbacService;
  /** Resolves a job's target (type, id) or null if the job does not exist. */
  jobTarget(jobId: string): Promise<{ targetType: string | null; targetId: string | null } | null>;
}

/** Per-topic subscription authorisation (api.md "Realtime"). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function authorizeTopic(topic: string, principal: Principal, deps: TopicDeps): Promise<boolean> {
  const [kind, id = ""] = topic.split(":");
  if (topic.includes(":") && !UUID_RE.test(id)) return false;
  switch (kind) {
    case "overview":
    case "nodes":
    case "servers":
      return TOPIC_PATTERNS[kind].test(topic) && hasPermissionAnywhere(principal, "monitoring.view");
    case "alerts":
      return TOPIC_PATTERNS.alerts.test(topic) && hasPermissionAnywhere(principal, "alerts.view");
    case "node":
      return TOPIC_PATTERNS.node.test(topic) && authorize(principal, "nodes.view", { type: "node", id });
    case "network":
      return TOPIC_PATTERNS.network.test(topic) && authorize(principal, "networks.view", { type: "network", id });
    case "server":
    case "console": {
      if (!TOPIC_PATTERNS[kind].test(topic)) return false;
      const resource = await deps.rbac.server(id);
      if (!resource) return false;
      return authorize(principal, kind === "server" ? "servers.view" : "servers.console.view", resource);
    }
    case "job": {
      if (!TOPIC_PATTERNS.job.test(topic)) return false;
      const job = await deps.jobTarget(id);
      if (!job) return false;
      const resource = await deps.rbac.resolve(job.targetType, job.targetId);
      return resource ? authorize(principal, "jobs.view", resource) : false;
    }
    default:
      return false;
  }
}
