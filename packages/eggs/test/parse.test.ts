import { describe, expect, it } from "vitest";
import { TemplateImportPreview } from "@blockforge/contracts";
import { exportEgg, parseEgg, slugify, templateFromPreview } from "../src/index.js";
import { allEggFixtures, codes, eggFixture } from "./helpers.js";

const parse = (name: string, opts: Partial<Parameters<typeof parseEgg>[1]> = {}) => parseEgg(eggFixture(name), { category: "Test", ...opts });

describe("parseEgg on real eggs (pterodactyl/panel @ 9b97ae11, pelican-eggs/* @ 2026-10-12)", () => {
  it.each(allEggFixtures())("%s imports without errors and matches the contract", (name) => {
    const preview = parse(name);
    expect(codes(preview.issues, "error"), JSON.stringify(preview.issues.filter((i) => i.severity === "error"))).toEqual([]);
    expect(TemplateImportPreview.parse(preview)).toEqual(preview);
    expect(preview.template).not.toBeNull();
  });

  it("Paper (PTDL_v2): images, JSON-encoded config, done, stop, install, variables, game", () => {
    const p = parse("ptero-egg-paper.json");
    const t = templateFromPreview(p);
    expect(t).toMatchObject({
      key: "paper",
      name: "Paper",
      kind: "egg",
      source: "import",
      sourceFormat: "PTDL_v2",
      author: "parker@pterodactyl.io",
      game: "minecraft-java",
      startupDone: [")! For help, type "],
      stop: { type: "command", command: "stop" },
      features: ["eula", "java_version", "pid_limit"],
      runtime: { dataMountPath: "/home/container", readOnlyRootfs: true },
    });
    expect(t.dockerImages[0]).toEqual({ label: "Java 25", image: "ghcr.io/pterodactyl/yolks:java_25" });
    expect(t.dockerImages).toHaveLength(6);
    expect(t.configFiles).toEqual([
      { path: "server.properties", parser: "properties", find: { "server-ip": "0.0.0.0", "server-port": "{{server.build.default.port}}", "query.port": "{{server.build.default.port}}" } },
    ]);
    expect(t.install).toMatchObject({ image: "ghcr.io/pterodactyl/installers:alpine", entrypoint: "ash" });
    expect(t.install!.script).not.toContain("\r\n");
    expect(t.variables.map((v) => v.envName)).toEqual(["MINECRAFT_VERSION", "SERVER_JARFILE", "DL_PATH", "BUILD_NUMBER"]);
    expect(t.variables.find((v) => v.envName === "DL_PATH")).toMatchObject({ userViewable: false, userEditable: false });
    expect(p.imagesNeedingAllowlist).toEqual([]);
    expect(codes(p.issues)).toContain("GAME_SUGGESTED");
  });

  it("detects game types", () => {
    expect(parse("ptero-egg-forge-minecraft.json").template!.game).toBe("minecraft-java");
    expect(parse("ptero-egg-vanilla-minecraft.json").template!.game).toBe("minecraft-java");
    expect(parse("ptero-egg-sponge--sponge-vanilla.json").template!.game).toBe("minecraft-java");
    expect(parse("ptero-egg-bungeecord.json").template!.game).toBe("minecraft-proxy");
    expect(parse("ptero-egg-rust.json").template!.game).toBe("other");
    expect(parse("pelican-games-standalone-egg-pterodactyl-factorio.json").template!.game).toBe("other");
    expect(parse("ptero-egg-rust.json", { game: "minecraft-java" }).template!.game).toBe("minecraft-java");
    expect(codes(parse("ptero-egg-rust.json", { game: "other" }).issues)).not.toContain("GAME_SUGGESTED");
  });

  it("BungeeCord: yaml rule with [0] index, wildcard and regex map value", () => {
    const t = parse("ptero-egg-bungeecord.json").template!;
    expect(t.stop).toEqual({ type: "command", command: "end" });
    expect(t.configFiles[0]).toEqual({
      path: "config.yml",
      parser: "yaml",
      find: {
        "listeners[0].query_port": "{{server.build.default.port}}",
        "listeners[0].host": "0.0.0.0:{{server.build.default.port}}",
        "servers.*.address": { "regex:^(127\\.0\\.0\\.1|localhost)(:\\d{1,5})?$": "{{config.docker.interface}}$2" },
      },
    });
  });

  it("PTDL_v1 (Garry's Mod): `images` array, non-allowlisted image, missing field_type", () => {
    const p = parse("ptero-egg-garrys-mod.json");
    expect(p.template!.sourceFormat).toBe("PTDL_v1");
    expect(p.template!.dockerImages).toEqual([{ label: "ghcr.io/pterodactyl/games:source", image: "ghcr.io/pterodactyl/games:source" }]);
    expect(p.imagesNeedingAllowlist).toEqual(["ghcr.io/pterodactyl/games:source"]);
    expect(codes(p.issues, "warning")).toContain("IMAGE_NOT_ALLOWLISTED");
    expect(p.template!.stop).toEqual({ type: "command", command: "quit" });
  });

  it("signals: ^C → SIGINT (Mumble, TeamSpeak, Valheim)", () => {
    for (const f of ["ptero-egg-mumble-server.json", "ptero-egg-teamspeak3-server.json", "pelican-games-steamcmd-egg-valheim.json"]) {
      expect(parse(f).template!.stop).toEqual({ type: "signal", signal: "SIGINT" });
    }
  });

  it("PLCN_v3 (Valheim): startup_commands, rules arrays, /bin/bash entrypoint", () => {
    const p = parse("pelican-games-steamcmd-egg-valheim.json");
    const t = p.template!;
    expect(t.sourceFormat).toBe("PLCN_v1");
    expect(codes(p.issues, "info")).toContain("SOURCE_FORMAT_RECORDED_AS_PLCN_V1");
    expect(t.startup).toMatch(/^\.\/valheim_server\.x86_64 -nographics/);
    expect(t.variables.find((v) => v.envName === "AUTO_UPDATE")?.rules).toBe("boolean");
    expect(p.imagesNeedingAllowlist).toEqual(["ghcr.io/parkervcp/games:valheim"]);
    const tshock = parse("pelican-games-standalone-egg-tshock.json");
    expect(tshock.template!.install!.entrypoint).toBe("bash");
    expect(codes(tshock.issues, "info")).toContain("INSTALL_ENTRYPOINT_NORMALISED");
  });

  it("PLCN_v1 (FiveM) and PLCN_v2 (Trackmania, Factorio ARM)", () => {
    const five = parse("pelican-games-standalone-egg-five-m.json").template!;
    expect(five.configFiles[0]!.parser).toBe("file");
    expect(five.configFiles[0]!.find["sv_maxclients"]).toBe("sv_maxclients {{server.environment.MAX_PLAYERS}}");
    expect(five.variables.find((v) => v.envName === "MAX_PLAYERS")?.rules).toBe("required|integer|between:1,48");
    const tm = parse("pelican-games-standalone-egg-trackmania2020.json").template!;
    expect(tm.configFiles[0]).toMatchObject({ path: "UserData/Config/dedicated_cfg.xml", parser: "xml" });
    const arm = parse("pelican-games-standalone-egg-factorio-a-r-m64.json");
    expect(arm.template!.configFiles[0]!.find["max_players"]).toBe("{{server.environment.MAX_SLOTS}}");
    expect(codes(arm.issues, "warning")).not.toContain("UNKNOWN_PLACEHOLDER");
  });

  it("OpenTTD: numeric find values are stored as strings; lowercase env names are accepted", () => {
    const p = parse("pelican-games-standalone-egg-openttd.json");
    expect(p.template!.configFiles[0]!.find["network.lan_internet"]).toBe("0");
    expect(codes(p.issues, "info")).toContain("CONFIG_VALUE_STRINGIFIED");
    expect(p.template!.variables.map((v) => v.envName)).toContain("srv_name");
  });

  it("reports unsupported rules without failing", () => {
    const egg = eggFixture("ptero-egg-paper.json");
    (egg["variables"] as Array<Record<string, unknown>>)[0]!["rules"] = "required|string|uuid|required_with:FOO";
    const p = parseEgg(egg, { category: "x" });
    expect(p.template).not.toBeNull();
    const w = p.issues.find((i) => i.code === "VARIABLE_RULES_UNSUPPORTED");
    expect(w?.message).toMatch(/uuid, required_with/);
  });
});

describe("parseEgg error handling", () => {
  const base = () => eggFixture("ptero-egg-vanilla-minecraft.json");
  const errors = (egg: unknown) => codes(parseEgg(egg, { category: "x" }).issues, "error");

  it("rejects non-eggs", () => {
    expect(errors("nope")).toEqual(["EGG_UNPARSEABLE"]);
    expect(errors({ name: "x" })).toEqual(["EGG_FORMAT_UNKNOWN"]);
    expect(errors({ meta: { version: "PTDL_v9" } })).toEqual(["EGG_FORMAT_UNKNOWN"]);
  });

  it("requires a startup command", () => {
    const e = base();
    e["startup"] = "  ";
    expect(errors(e)).toContain("STARTUP_MISSING");
  });

  it("rejects reserved, invalid and duplicate variable names", () => {
    const e = base();
    const vars = e["variables"] as Array<Record<string, unknown>>;
    vars.push({ ...vars[0], env_variable: "SERVER_PORT" }, { ...vars[0], env_variable: "tz" }, { ...vars[0], env_variable: "1BAD" }, { ...vars[0] });
    expect(errors(e)).toEqual(expect.arrayContaining(["VARIABLE_NAME_RESERVED", "VARIABLE_NAME_INVALID", "VARIABLE_DUPLICATE"]));
    expect(parseEgg(e, { category: "x" }).template).toBeNull();
  });

  it("rejects invalid images, unsupported entrypoints and oversized scripts", () => {
    const e = base();
    e["docker_images"] = { Bad: "Ghcr.io/UPPER/Case:tag", Port: "registry.example.com:5000/img:1" };
    expect(errors(e)).toEqual(["INVALID_IMAGE", "INVALID_IMAGE"]);
    const s = base();
    (s["scripts"] as { installation: Record<string, unknown> }).installation["entrypoint"] = "python3";
    expect(errors(s)).toEqual(["INSTALL_ENTRYPOINT_UNSUPPORTED"]);
    const big = base();
    (big["scripts"] as { installation: Record<string, unknown> }).installation["script"] = "#!/bin/ash\n" + "echo x\n".repeat(10_000);
    expect(errors(big)).toEqual(["INSTALL_SCRIPT_TOO_LARGE"]);
  });

  it("rejects config file paths outside the server root, normalises a leading slash", () => {
    const e = base();
    (e["config"] as Record<string, unknown>)["files"] = JSON.stringify({ "../etc/passwd": { parser: "file", find: { a: "b" } } });
    expect(errors(e)).toEqual(["CONFIG_FILE_PATH_INVALID"]);
    const n = base();
    (n["config"] as Record<string, unknown>)["files"] = { "/properties/server.properties": { parser: "properties", find: { a: "b" } } };
    const p = parseEgg(n, { category: "x" });
    expect(p.template!.configFiles[0]!.path).toBe("properties/server.properties");
  });

  it("flags unparseable config JSON, unknown placeholders, bashisms, alpine+bash and missing done", () => {
    const e = base();
    (e["config"] as Record<string, unknown>)["files"] = "{not json";
    expect(errors(e)).toEqual(["CONFIG_UNPARSEABLE"]);
    const w = base();
    w["startup"] = "java -jar {{SERVER_JARFILE}} --port {{NOT_A_VAR}} --mem {{SERVER_MEMORY}}";
    (w["config"] as Record<string, unknown>)["files"] = { "a.json": { parser: "json", find: { x: "{{server.build.nope}}", y: "{{env.SERVER_JARFILE}}" } } };
    (w["config"] as Record<string, unknown>)["startup"] = "{}";
    const inst = (w["scripts"] as { installation: Record<string, unknown> }).installation;
    inst["entrypoint"] = "ash";
    inst["script"] = "if [[ -f x ]]; then echo; fi";
    const p = parseEgg(w, { category: "x" });
    expect(codes(p.issues, "warning")).toEqual(expect.arrayContaining(["UNKNOWN_PLACEHOLDER", "NO_DONE_PATTERN", "INSTALL_SCRIPT_BASHISMS"]));
    expect(p.issues.filter((i) => i.code === "UNKNOWN_PLACEHOLDER").map((i) => i.message).join(" ")).toMatch(/NOT_A_VAR.*server\.build\.nope|server\.build\.nope.*NOT_A_VAR/s);
    const a = base();
    (a["scripts"] as { installation: Record<string, unknown> }).installation["entrypoint"] = "bash";
    expect(codes(parseEgg(a, { category: "x" }).issues, "warning")).toContain("INSTALL_ENTRYPOINT_MISMATCH");
  });

  it("handles stop variants", () => {
    const stop = (v: unknown) => {
      const e = base();
      (e["config"] as Record<string, unknown>)["stop"] = v;
      return parseEgg(e, { category: "x" });
    };
    expect(stop("^SIGTERM").template!.stop).toEqual({ type: "signal", signal: "SIGTERM" });
    expect(stop("^c").template!.stop).toEqual({ type: "signal", signal: "SIGINT" });
    expect(stop("^SIGABRT").template!.stop).toEqual({ type: "signal", signal: "SIGTERM" });
    expect(codes(stop("^SIGABRT").issues)).toContain("STOP_SIGNAL_UNSUPPORTED");
    expect(stop("").template!.stop).toEqual({ type: "signal", signal: "SIGTERM" });
    expect(codes(stop("a\nb").issues, "error")).toEqual(["STOP_INVALID"]);
  });

  it("accepts Pelican-style object config members and string arrays of done lines", () => {
    const e = base();
    e["config"] = { files: {}, startup: { done: ["Done (", "regex:^ready$"] }, logs: {}, stop: "stop" };
    expect(parseEgg(e, { category: "x" }).template!.startupDone).toEqual(["Done (", "regex:^ready$"]);
  });
});

describe("export + round trip", () => {
  it.each(allEggFixtures())("%s: parse → export → parse is stable", (name) => {
    const first = templateFromPreview(parseEgg(eggFixture(name), { category: "Test" }));
    const exported = exportEgg(first, { exportedAt: new Date("2026-10-12T00:00:00Z") });
    expect((exported["meta"] as { version: string }).version).toBe("PTDL_v2");
    const json = JSON.parse(JSON.stringify(exported)) as unknown;
    const second = templateFromPreview(parseEgg(json, { category: "Test", game: first.game }));
    const { sourceFormat: _a, ...a } = first;
    const { sourceFormat: _b, ...b } = second;
    expect(b).toEqual(a);
    expect(second.sourceFormat).toBe("PTDL_v2");
  });

  it("writes Pterodactyl's shapes", () => {
    const t = templateFromPreview(parseEgg(eggFixture("ptero-egg-mumble-server.json"), { category: "Voice" }));
    const e = exportEgg(t, { exportedAt: new Date("2026-10-12T00:00:00Z") });
    expect(e["exported_at"]).toBe("2026-10-12T00:00:00+00:00");
    expect((e["config"] as Record<string, unknown>)["stop"]).toBe("^C");
    expect(typeof (e["config"] as Record<string, unknown>)["files"]).toBe("string");
    expect(JSON.parse((e["config"] as Record<string, string>)["startup"]!)).toEqual({ done: "Server listening on" });
    expect((e["variables"] as Array<Record<string, unknown>>)[0]).toEqual({
      name: "Maximum Users",
      description: expect.any(String),
      env_variable: "MAX_USERS",
      default_value: "100",
      user_viewable: true,
      user_editable: false,
      rules: "required|numeric|digits_between:1,5",
      field_type: "text",
    });
  });

  it("slugifies names", () => {
    expect(slugify("Garrys Mod")).toBe("garrys-mod");
    expect(slugify("ARK: Survival Evolved")).toBe("ark-survival-evolved");
    expect(slugify("Ü")).toBe("egg-u");
    expect(slugify("x".repeat(100))).toHaveLength(48);
  });
});
