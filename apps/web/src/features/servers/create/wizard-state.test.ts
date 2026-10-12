import { beforeAll, describe, expect, it } from "vitest";
import type { TemplateSummary } from "@blockforge/contracts";
import { NODE_ID, TEMPLATE_ID } from "@/test/fixtures";
import {
  buildCreateBody,
  eggNeedsEula,
  firstInvalidStep,
  initialWizardState,
  parseJvmArgs,
  slugify,
  stepForPath,
  validateStep,
  validateWizard,
} from "./wizard-state";
import type { WizardState } from "./wizard-state";
import { loadVariableRules } from "@/lib/variable-validation";

// Egg variable checks use the full (lazily loaded) rule engine.
beforeAll(() => loadVariableRules());

const minecraftTemplate: TemplateSummary = {
  id: TEMPLATE_ID,
  key: "minecraft",
  name: "Minecraft: Java Edition",
  description: "",
  category: "Minecraft",
  kind: "minecraft",
  game: "minecraft-java",
  dockerImages: [],
  features: [],
  serverCount: 0,
  variables: [],
};

const eggTemplate: TemplateSummary = {
  ...minecraftTemplate,
  id: "88888888-8888-4888-8888-888888888888",
  key: "terraria",
  name: "Terraria",
  category: "Games",
  kind: "egg",
  game: "other",
  dockerImages: [{ label: "Debian", image: "ghcr.io/parkervcp/yolks:debian" }],
  variables: [
    {
      envName: "MAX_PLAYERS",
      name: "Max players",
      description: "",
      defaultValue: "8",
      userViewable: true,
      userEditable: true,
      rules: "required|integer|between:1,255",
      sortOrder: 0,
    },
    {
      envName: "WORLD_SIZE",
      name: "World size",
      description: "",
      defaultValue: "2",
      userViewable: true,
      userEditable: true,
      rules: "required|in:1,2,3",
      sortOrder: 1,
    },
    {
      envName: "VERSION",
      name: "Version",
      description: "",
      defaultValue: "latest",
      userViewable: true,
      userEditable: false,
      rules: "required|string",
      sortOrder: 2,
    },
  ],
};

function mcState(patch: Partial<WizardState> = {}): WizardState {
  return {
    ...initialWizardState(),
    templateId: TEMPLATE_ID,
    name: "Survival World",
    slug: "survival-world",
    software: "paper",
    version: "1.21.4",
    acceptEula: true,
    memoryMiB: "4096",
    ...patch,
  };
}

describe("slugify", () => {
  it("produces contract-valid identifiers", () => {
    expect(slugify("My Survival World!")).toBe("my-survival-world");
    expect(slugify("  Été  ")).toBe("ete");
    expect(slugify("Ab")).toBe("ab-server");
    expect(slugify("x")).toBe("x-server");
    expect(slugify("")).toBe("");
    expect(slugify("a".repeat(80)).length).toBe(48);
  });
});

describe("validateStep", () => {
  it("requires a template, a name and a valid identifier", () => {
    const e = validateStep("template", { ...initialWizardState(), slug: "No Spaces" }, null);
    expect(Object.keys(e).sort()).toEqual(["name", "slug", "templateId"]);
  });

  it("requires software, version and the EULA for Minecraft game servers", () => {
    const e = validateStep(
      "configure",
      mcState({ software: null, version: null, acceptEula: false }),
      minecraftTemplate,
    );
    expect(e.software).toBeTruthy();
    expect(e.version).toBeTruthy();
    expect(validateStep("configure", mcState({ acceptEula: false }), minecraftTemplate).acceptEula).toMatch(
      /EULA/,
    );
  });

  it("does not ask for the EULA for Velocity proxies", () => {
    const e = validateStep(
      "configure",
      mcState({ software: "velocity", version: "3.4.0", acceptEula: false }),
      {
        ...minecraftTemplate,
        kind: "velocity",
      },
    );
    expect(e).toEqual({});
  });

  it("rejects JVM flags that are not flags", () => {
    expect(
      validateStep("configure", mcState({ jvmArgs: "-Xss1M\nrm -rf /" }), minecraftTemplate).jvmArgs,
    ).toBeTruthy();
    expect(parseJvmArgs("  -Xss1M \n\n-Dfoo=bar ")).toEqual(["-Xss1M", "-Dfoo=bar"]);
  });

  it("checks gameplay ranges", () => {
    const e = validateStep(
      "configure",
      mcState({ gameplay: { ...mcState().gameplay, maxPlayers: "0", viewDistance: "64" } }),
      minecraftTemplate,
    );
    expect(Object.keys(e).sort()).toEqual(["maxPlayers", "viewDistance"]);
  });

  it("validates egg variables with their rules, skipping fixed ones", () => {
    const s = {
      ...initialWizardState(),
      templateId: eggTemplate.id,
      dockerImage: null,
      variables: { MAX_PLAYERS: "999", WORLD_SIZE: "9", VERSION: "" },
    };
    const e = validateStep("configure", s, eggTemplate);
    expect(e["var.MAX_PLAYERS"]).toMatch(/between 1 and 255/);
    expect(e["var.WORLD_SIZE"]).toMatch(/one of/);
    expect(e["var.VERSION"]).toBeUndefined(); // not user-editable
    expect(e.dockerImage).toBeTruthy();
  });

  it("requires a node and allocation when chosen explicitly", () => {
    const e = validateStep(
      "placement",
      mcState({ placementMode: "node", allocationMode: "specific" }),
      minecraftTemplate,
    );
    expect(Object.keys(e).sort()).toEqual(["allocationId", "nodeId"]);
  });

  it("checks resources, including heap headroom", () => {
    const e = validateStep(
      "resources",
      mcState({ memoryMiB: "100", cpuCores: "0.1", diskGiB: "-1", allocationLimit: "60", backupLimit: "x" }),
      minecraftTemplate,
    );
    expect(Object.keys(e).sort()).toEqual([
      "allocationLimit",
      "backupLimit",
      "cpuCores",
      "diskGiB",
      "memoryMiB",
    ]);
    expect(
      validateStep("resources", mcState({ memoryMiB: "2048", heapMiB: "2048" }), minecraftTemplate).heapMiB,
    ).toMatch(/smaller/);
  });
});

describe("buildCreateBody / validateWizard", () => {
  it("builds a valid Minecraft request", () => {
    const { body, errors } = validateWizard(
      mcState({ cpuCores: "2.5", diskGiB: "20", heapMiB: "3072" }),
      minecraftTemplate,
    );
    expect(errors).toEqual({});
    expect(body).toMatchObject({
      name: "Survival World",
      slug: "survival-world",
      memoryLimitBytes: 4096 * 1024 ** 2,
      cpuLimitMillicores: 2500,
      storageQuotaBytes: 20 * 1024 ** 3,
      placement: { mode: "auto" },
      allocation: { mode: "auto" },
      minecraft: {
        software: "paper",
        version: "1.21.4",
        build: null,
        acceptEula: true,
        heapMaxBytes: 3072 * 1024 ** 2,
      },
    });
    expect(body?.egg).toBeUndefined();
  });

  it("builds an egg request with only editable variables", () => {
    const s = {
      ...mcState(),
      templateId: eggTemplate.id,
      dockerImage: "ghcr.io/parkervcp/yolks:debian",
      variables: { MAX_PLAYERS: "16", VERSION: "1.4.4" },
    };
    const body = buildCreateBody(s, eggTemplate);
    expect(body.minecraft).toBeUndefined();
    expect(body.egg).toEqual({
      dockerImage: "ghcr.io/parkervcp/yolks:debian",
      variables: { MAX_PLAYERS: "16" },
      acceptEula: false,
    });
    expect(validateWizard(s, eggTemplate).body).not.toBeNull();
  });

  it("uses node placement and a specific allocation when chosen", () => {
    const allocationId = "99999999-9999-4999-8999-999999999999";
    const body = buildCreateBody(
      mcState({ placementMode: "node", nodeId: NODE_ID, allocationMode: "specific", allocationId }),
      minecraftTemplate,
    );
    expect(body.placement).toEqual({ mode: "node", nodeId: NODE_ID });
    expect(body.allocation).toEqual({ mode: "specific", allocationId });
  });

  it("reports contract violations on the right step", () => {
    const { body, errors } = validateWizard(mcState({ acceptEula: false, slug: "x" }), minecraftTemplate);
    expect(body).toBeNull();
    expect(errors.template?.slug).toBeTruthy();
    expect(errors.configure?.acceptEula).toBeTruthy();
    expect(firstInvalidStep(errors)).toBe("template");
  });

  it("maps request paths to steps", () => {
    expect(stepForPath("slug")).toBe("template");
    expect(stepForPath("minecraft.acceptEula")).toBe("configure");
    expect(stepForPath("minecraft.heapMaxBytes")).toBe("resources");
    expect(stepForPath("egg.variables.MAX_PLAYERS")).toBe("configure");
    expect(stepForPath("allocation.allocationId")).toBe("placement");
    expect(stepForPath("memoryLimitBytes")).toBe("resources");
  });
});

describe("eggs with the eula feature", () => {
  const vanillaEgg: TemplateSummary = {
    ...eggTemplate,
    id: "77777777-7777-4777-8777-777777777777",
    key: "vanilla-minecraft",
    name: "Vanilla Minecraft",
    game: "minecraft-java",
    features: ["eula", "java_version"],
    variables: [],
  };
  const base = () => ({
    ...mcState(),
    templateId: vanillaEgg.id,
    dockerImage: "ghcr.io/parkervcp/yolks:debian",
    acceptEula: false,
  });

  it("blocks creation until the EULA is accepted", () => {
    expect(eggNeedsEula(vanillaEgg)).toBe(true);
    expect(eggNeedsEula(eggTemplate)).toBe(false);
    expect(eggNeedsEula(minecraftTemplate)).toBe(false); // built-ins use minecraft.acceptEula
    expect(validateStep("configure", base(), vanillaEgg).acceptEula).toMatch(/EULA/);
    expect(validateWizard(base(), vanillaEgg).body).toBeNull();
  });

  it("sends egg.acceptEula once accepted", () => {
    const { body, errors } = validateWizard({ ...base(), acceptEula: true }, vanillaEgg);
    expect(errors).toEqual({});
    expect(body?.egg).toMatchObject({ acceptEula: true });
    // Templates without the feature never send consent.
    expect(buildCreateBody({ ...base(), acceptEula: true }, eggTemplate).egg?.acceptEula).toBe(false);
  });
});

describe("administrators may set non-user-editable variables", () => {
  const s = () => ({
    ...mcState(),
    templateId: eggTemplate.id,
    dockerImage: "ghcr.io/parkervcp/yolks:debian",
    variables: { MAX_PLAYERS: "16", VERSION: "" },
  });
  it("validates and sends them only for admins", () => {
    expect(validateStep("configure", s(), eggTemplate)["var.VERSION"]).toBeUndefined();
    expect(validateStep("configure", s(), eggTemplate, { admin: true })["var.VERSION"]).toMatch(/required/);
    const adminBody = buildCreateBody(
      { ...s(), variables: { MAX_PLAYERS: "16", VERSION: "1.4.4" } },
      eggTemplate,
      { admin: true },
    );
    expect(adminBody.egg?.variables).toEqual({ MAX_PLAYERS: "16", VERSION: "1.4.4" });
    const userBody = buildCreateBody(
      { ...s(), variables: { MAX_PLAYERS: "16", VERSION: "1.4.4" } },
      eggTemplate,
    );
    expect(userBody.egg?.variables).toEqual({ MAX_PLAYERS: "16" });
  });
});
