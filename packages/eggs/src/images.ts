/**
 * Docker image references and the node agent's image allowlist semantics (port of
 * services/node-agent/internal/config/allowlist.go): Docker Hub short names are normalised
 * (`eclipse-temurin` ≡ `docker.io/library/eclipse-temurin`), registries with ports are rejected,
 * an entry `repo:*` matches any tag (never digest references) of exactly `repo`, other entries
 * must match the full normalised reference.
 */

export interface ImageRef {
  /** e.g. `docker.io/library/eclipse-temurin`, `ghcr.io/pterodactyl/yolks`. */
  repo: string;
  tag: string;
  digest: string;
}

const RE_REPO_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const RE_REGISTRY = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;
const RE_TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const RE_DIGEST = /^sha256:[a-f0-9]{64}$/;

export class ImageRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRefError";
  }
}

export function parseImageRef(s: string): ImageRef {
  if (s === "" || s.length > 255) throw new ImageRefError("invalid image reference");
  let name = s;
  let digest = "";
  let tag = "";
  const at = name.indexOf("@");
  if (at >= 0) {
    digest = name.slice(at + 1);
    name = name.slice(0, at);
    if (!RE_DIGEST.test(digest)) throw new ImageRefError("invalid image digest");
  }
  const colon = name.lastIndexOf(":");
  if (colon > name.lastIndexOf("/")) {
    tag = name.slice(colon + 1);
    name = name.slice(0, colon);
    if (!RE_TAG.test(tag)) throw new ImageRefError("invalid image tag");
  }
  let parts = name.split("/");
  let registry = "docker.io";
  if (parts.length > 1 && (/[.:]/.test(parts[0]!) || parts[0] === "localhost")) {
    registry = parts[0]!;
    parts = parts.slice(1);
    if (registry.includes(":")) throw new ImageRefError("image registries with ports are not supported");
    if (!RE_REGISTRY.test(registry)) throw new ImageRefError("invalid image registry");
    registry = registry.toLowerCase();
  }
  if (registry === "index.docker.io") registry = "docker.io";
  if (parts.length === 0) throw new ImageRefError("invalid image reference");
  for (const p of parts) if (!RE_REPO_COMPONENT.test(p)) throw new ImageRefError(`invalid image name component "${p}"`);
  if (registry === "docker.io" && parts.length === 1) parts = ["library", ...parts];
  return { repo: `${registry}/${parts.join("/")}`, tag, digest };
}

export function isValidImageRef(s: string): boolean {
  try {
    parseImageRef(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Default `imageAllowlist` of the node agent (agent-protocol.md §6): the images community eggs use.
 * Operators extend it in the agent config; the control plane cannot change it.
 */
export const DEFAULT_AGENT_IMAGE_ALLOWLIST: readonly string[] = [
  "eclipse-temurin:*",
  "ghcr.io/pterodactyl/yolks:*",
  "ghcr.io/pterodactyl/installers:*",
  "ghcr.io/parkervcp/yolks:*",
  "ghcr.io/parkervcp/installers:*",
];

/** Whether `image` is allowed by `allowlist` (agent semantics). Invalid references are never allowed. */
export function imageAllowed(image: string, allowlist: readonly string[] = DEFAULT_AGENT_IMAGE_ALLOWLIST): boolean {
  let ref: ImageRef;
  try {
    ref = parseImageRef(image);
  } catch {
    return false;
  }
  for (const raw of allowlist) {
    let entry = raw.trim();
    const anyTag = entry.endsWith(":*");
    if (anyTag) entry = entry.slice(0, -2);
    if (entry.includes("*")) continue;
    let rule: ImageRef;
    try {
      rule = parseImageRef(entry);
    } catch {
      continue;
    }
    if (anyTag) {
      if (rule.tag !== "" || rule.digest !== "") continue;
      if (ref.repo === rule.repo && ref.tag !== "" && ref.digest === "") return true;
      continue;
    }
    if (ref.repo === rule.repo && ref.tag === rule.tag && ref.digest === rule.digest) return true;
  }
  return false;
}
