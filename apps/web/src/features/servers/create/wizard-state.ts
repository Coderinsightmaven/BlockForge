import { CreateServerRequest, Slug, softwareKind } from "@blockforge/contracts";
import type { ServerSoftware, TemplateSummary } from "@blockforge/contracts";
import type { z } from "zod";
import { validateVariableValue } from "@/lib/variable-rules";

export type WizardStep = "template" | "configure" | "placement" | "resources" | "review";
export const WIZARD_STEPS: WizardStep[] = ["template", "configure", "placement", "resources", "review"];
export const STEP_LABELS: Record<WizardStep, string> = {
  template: "Template",
  configure: "Software",
  placement: "Placement",
  resources: "Resources",
  review: "Review",
};

export interface GameplayForm {
  motd: string;
  maxPlayers: string;
  difficulty: "peaceful" | "easy" | "normal" | "hard";
  gamemode: "survival" | "creative" | "adventure" | "spectator";
  onlineMode: boolean;
  whitelist: boolean;
  pvp: boolean;
  hardcore: boolean;
  viewDistance: string;
  simulationDistance: string;
  levelSeed: string;
}

export interface WizardState {
  templateId: string | null;
  name: string;
  slug: string;
  slugTouched: boolean;
  description: string;
  // Minecraft / Velocity (built-in templates)
  software: ServerSoftware | null;
  version: string | null;
  /** null = latest stable build. */
  build: string | null;
  jvmPreset: "default" | "aikar" | "none";
  /** One flag per line (advanced). */
  jvmArgs: string;
  /** "" = automatic (from the version metadata). */
  javaMajor: string;
  /** "" = automatic (~80 % of the memory limit). */
  heapMiB: string;
  acceptEula: boolean;
  gameplay: GameplayForm;
  // Eggs
  dockerImage: string | null;
  variables: Record<string, string>;
  // Placement
  placementMode: "auto" | "node";
  nodeId: string | null;
  preferTags: string;
  allocationMode: "auto" | "specific";
  allocationId: string | null;
  // Resources
  memoryMiB: string;
  /** "" = no limit. */
  cpuCores: string;
  /** "" = no quota. */
  diskGiB: string;
  allocationLimit: string;
  backupLimit: string;
  startup: "auto" | "manual";
  /** null = the current user. */
  ownerId: string | null;
}

export const DEFAULT_GAMEPLAY: GameplayForm = {
  motd: "A BlockForge server",
  maxPlayers: "20",
  difficulty: "easy",
  gamemode: "survival",
  onlineMode: true,
  whitelist: false,
  pvp: true,
  hardcore: false,
  viewDistance: "10",
  simulationDistance: "10",
  levelSeed: "",
};

export function initialWizardState(): WizardState {
  return {
    templateId: null,
    name: "",
    slug: "",
    slugTouched: false,
    description: "",
    software: null,
    version: null,
    build: null,
    jvmPreset: "default",
    jvmArgs: "",
    javaMajor: "",
    heapMiB: "",
    acceptEula: false,
    gameplay: { ...DEFAULT_GAMEPLAY },
    dockerImage: null,
    variables: {},
    placementMode: "auto",
    nodeId: null,
    preferTags: "",
    allocationMode: "auto",
    allocationId: null,
    memoryMiB: "2048",
    cpuCores: "",
    diskGiB: "",
    allocationLimit: "0",
    backupLimit: "3",
    startup: "auto",
    ownerId: null,
  };
}

/** "My Survival World!" → "my-survival-world" (fits the contract's `Slug`). */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return s.length >= 3 ? s : s ? `${s}-server`.slice(0, 48) : "";
}

export function isBuiltinTemplate(t: Pick<TemplateSummary, "kind">): boolean {
  return t.kind === "minecraft" || t.kind === "velocity";
}

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

export type StepErrors = Partial<Record<WizardStep, Record<string, string>>>;

function num(v: string): number {
  return v.trim() === "" ? Number.NaN : Number(v);
}

export function parseJvmArgs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Field-level checks for one step (fast, shown inline before the server is asked). */
export function validateStep(
  step: WizardStep,
  s: WizardState,
  template: TemplateSummary | null,
): Record<string, string> {
  const e: Record<string, string> = {};
  if (step === "template") {
    if (!s.templateId || !template) e.templateId = "Choose a template.";
    const name = s.name.trim();
    if (!name) e.name = "Give the server a name.";
    else if (name.length > 80) e.name = "At most 80 characters.";
    if (!Slug.safeParse(s.slug).success) e.slug = "3–48 lowercase letters, digits or hyphens.";
  }
  if (step === "configure" && template) {
    if (isBuiltinTemplate(template)) {
      if (!s.software) e.software = "Choose the server software.";
      if (!s.version) e.version = "Choose a version.";
      if (s.software && softwareKind(s.software) === "game" && !s.acceptEula)
        e.acceptEula = "You must accept the Minecraft EULA.";
      const args = parseJvmArgs(s.jvmArgs);
      if (args.length > 64) e.jvmArgs = "At most 64 flags.";
      else if (args.some((a) => !a.startsWith("-") || a.length > 512))
        e.jvmArgs = "Each line must be one flag starting with '-' (max 512 characters).";
      if (s.javaMajor.trim() !== "") {
        const j = num(s.javaMajor);
        if (!Number.isInteger(j) || j < 8 || j > 40) e.javaMajor = "Java 8–40, or empty for automatic.";
      }
      if (s.software && softwareKind(s.software) === "game") {
        const g = s.gameplay;
        const mp = num(g.maxPlayers);
        if (!Number.isInteger(mp) || mp < 1 || mp > 10_000) e.maxPlayers = "1–10000.";
        for (const k of ["viewDistance", "simulationDistance"] as const) {
          const d = num(g[k]);
          if (!Number.isInteger(d) || d < 2 || d > 32) e[k] = "2–32 chunks.";
        }
        if (g.motd.length > 256) e.motd = "At most 256 characters.";
        if (g.levelSeed.length > 64) e.levelSeed = "At most 64 characters.";
      }
    } else {
      if (template.dockerImages.length > 0 && !s.dockerImage) e.dockerImage = "Choose an image.";
      for (const v of template.variables) {
        if (!v.userEditable) continue;
        const value = s.variables[v.envName] ?? v.defaultValue;
        const err = validateVariableValue(v, value);
        if (err) e[`var.${v.envName}`] = err;
      }
    }
  }
  if (step === "placement") {
    if (s.placementMode === "node" && !s.nodeId) e.nodeId = "Choose a node.";
    if (s.allocationMode === "specific" && !s.allocationId) e.allocationId = "Choose an allocation.";
  }
  if (step === "resources") {
    const mem = num(s.memoryMiB);
    if (!Number.isFinite(mem) || mem < 256) e.memoryMiB = "At least 256 MiB.";
    if (s.cpuCores.trim() !== "") {
      const c = num(s.cpuCores);
      if (!Number.isFinite(c) || c < 0.25) e.cpuCores = "At least 0.25 cores, or empty for no limit.";
    }
    if (s.diskGiB.trim() !== "") {
      const d = num(s.diskGiB);
      if (!Number.isFinite(d) || d <= 0) e.diskGiB = "Enter a size, or empty for no quota.";
    }
    const al = num(s.allocationLimit);
    if (!Number.isInteger(al) || al < 0 || al > 50) e.allocationLimit = "0–50.";
    const bl = num(s.backupLimit);
    if (!Number.isInteger(bl) || bl < 0 || bl > 100) e.backupLimit = "0–100.";
    if (template && isBuiltinTemplate(template) && s.heapMiB.trim() !== "" && Number.isFinite(mem)) {
      const h = num(s.heapMiB);
      if (!Number.isFinite(h) || h < 128) e.heapMiB = "At least 128 MiB, or empty for automatic.";
      else if (h >= mem)
        e.heapMiB = "The heap must be smaller than the memory limit (the JVM needs headroom).";
    }
  }
  return e;
}

export type CreateServerInput = z.input<typeof CreateServerRequest>;

/** The request body for `POST /servers` (not yet validated). */
export function buildCreateBody(s: WizardState, template: TemplateSummary): CreateServerInput {
  const mem = Math.round(num(s.memoryMiB) * MiB);
  const body: CreateServerInput = {
    name: s.name.trim(),
    slug: s.slug,
    description: s.description.trim(),
    templateId: template.id,
    placement:
      s.placementMode === "node" && s.nodeId
        ? { mode: "node", nodeId: s.nodeId }
        : { mode: "auto", preferTags: s.preferTags.split(/[\s,]+/).filter(Boolean) },
    allocation:
      s.allocationMode === "specific" && s.allocationId
        ? { mode: "specific", allocationId: s.allocationId }
        : { mode: "auto" },
    memoryLimitBytes: mem,
    cpuLimitMillicores: s.cpuCores.trim() === "" ? null : Math.round(num(s.cpuCores) * 1000),
    storageQuotaBytes: s.diskGiB.trim() === "" ? null : Math.round(num(s.diskGiB) * GiB),
    allocationLimit: num(s.allocationLimit),
    backupLimit: num(s.backupLimit),
    startup: s.startup,
  };
  if (s.ownerId) body.ownerId = s.ownerId;
  if (isBuiltinTemplate(template)) {
    const game = !!s.software && softwareKind(s.software) === "game";
    const g = s.gameplay;
    body.minecraft = {
      software: s.software ?? "paper",
      version: s.version ?? "",
      build: s.build,
      javaMajor: s.javaMajor.trim() === "" ? null : num(s.javaMajor),
      jvmPreset: s.jvmPreset,
      jvmArgs: parseJvmArgs(s.jvmArgs),
      acceptEula: game ? s.acceptEula : false,
      gameplay: game
        ? {
            motd: g.motd,
            maxPlayers: num(g.maxPlayers),
            difficulty: g.difficulty,
            gamemode: g.gamemode,
            onlineMode: g.onlineMode,
            whitelist: g.whitelist,
            pvp: g.pvp,
            hardcore: g.hardcore,
            viewDistance: num(g.viewDistance),
            simulationDistance: num(g.simulationDistance),
            ...(g.levelSeed.trim() ? { levelSeed: g.levelSeed.trim() } : {}),
          }
        : {},
    };
    if (s.heapMiB.trim() !== "") body.minecraft.heapMaxBytes = Math.round(num(s.heapMiB) * MiB);
  } else {
    const variables: Record<string, string> = {};
    for (const v of template.variables) {
      if (v.userEditable && s.variables[v.envName] !== undefined)
        variables[v.envName] = s.variables[v.envName]!;
    }
    body.egg = { variables, ...(s.dockerImage ? { dockerImage: s.dockerImage } : {}) };
  }
  return body;
}

/** Which wizard step a request-body path belongs to (for server/zod issues). */
export function stepForPath(path: string): WizardStep {
  const head = path.split(".")[0] ?? "";
  if (["name", "slug", "description", "templateId"].includes(head)) return "template";
  if (head === "minecraft" && path.includes("heapMaxBytes")) return "resources";
  if (head === "minecraft" || head === "egg") return "configure";
  if (["placement", "allocation", "overrideCapacity", "networkId"].includes(head)) return "placement";
  return "resources";
}

/**
 * Validate everything: per-step checks plus the contract schema (which also enforces
 * cross-field rules such as heap < memory and the EULA). Returns the body when valid.
 */
export function validateWizard(
  s: WizardState,
  template: TemplateSummary | null,
): { body: z.output<typeof CreateServerRequest> | null; errors: StepErrors } {
  const errors: StepErrors = {};
  for (const step of WIZARD_STEPS) {
    const e = validateStep(step, s, template);
    if (Object.keys(e).length) errors[step] = e;
  }
  if (!template) return { body: null, errors };
  const parsed = CreateServerRequest.safeParse(buildCreateBody(s, template));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String).join(".");
      const step = stepForPath(path);
      const bucket = (errors[step] ??= {});
      bucket[path || "form"] ??= issue.message;
    }
  }
  const ok = Object.keys(errors).length === 0 && parsed.success;
  return { body: ok ? parsed.data : null, errors };
}

export function firstInvalidStep(errors: StepErrors): WizardStep | null {
  return WIZARD_STEPS.find((s) => errors[s] && Object.keys(errors[s]!).length > 0) ?? null;
}
