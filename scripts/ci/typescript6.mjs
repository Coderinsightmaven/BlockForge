#!/usr/bin/env node
// TypeScript 6 gates for the tsc-rs toolchain (docs/development/workflow.md, "Quality gates").
//
// `typecheck` and the `build` emit run tsc-rs (a port of the TypeScript 7 compiler), while ESLint,
// vitest, drizzle-kit and editors still use the `typescript` 6 package. These gates keep both honest:
//
//   node scripts/ci/typescript6.mjs check
//     Runs TypeScript 6 `tsc -p <config> --noEmit` over every project that a package's `typecheck`
//     script checks with tsc-rs, so an error only TypeScript 6 reports cannot reach main.
//
//   node scripts/ci/typescript6.mjs emit-parity      (after `pnpm build`)
//     Emits every project that a package's `build` script emits with tsc-rs again, with TypeScript 6,
//     into a temporary directory (`dist` is not touched), and compares the result with `dist`:
//       - the emitted file lists must be identical;
//       - every .js file must be byte-identical after the allowlisted normalisations below;
//       - every .d.ts file must be byte-identical, or identical after sorting the property
//         signatures of each type literal and the members of each union (order carries no meaning
//         in either; tsc 7 orders them differently);
//       - .js.map files are compared by name only (tsc 7 omits `sourceRoot: ""` and maps
//         compiler-written code such as parameter properties at coarser positions).
//
// Allowlisted .js normalisations (applied to the TypeScript 6 output only, line-anchored, exact):
//   EMPTY_NAMED_IMPORT  `import X, {} from "m";` -> `import X from "m";`
//     TypeScript 6 keeps the empty braces when every named import was type-only; tsc 7 drops them.
//     Both import the default binding only and evaluate the module the same way.
//
// Projects are found from the package scripts (`tsc-rs -p <config> [--noEmit]`), so a new package
// is covered without editing this file. Any other tsc-rs flag fails the gate until it is handled here.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MAX_PARALLEL = Math.max(1, Math.min(os.availableParallelism(), 4));
const ts = createRequire(path.join(ROOT, "package.json"))("typescript");

const NORMALISATIONS = [
  {
    name: "EMPTY_NAMED_IMPORT",
    pattern: /^import ([A-Za-z_$][\w$]*), \{\} from ("[^"\n]*"|'[^'\n]*');$/gm,
    replacement: "import $1 from $2;",
  },
];

class GateError extends Error {}

// ---- project discovery ---------------------------------------------------------------------------

function workspacePackageDirs() {
  const yaml = fs.readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const block = /^packages:\n((?:[ \t]+-[^\n]*\n)+)/m.exec(yaml);
  if (!block) throw new GateError("pnpm-workspace.yaml: no `packages:` list");
  const dirs = [];
  for (const line of block[1].split("\n").filter(Boolean)) {
    const glob = /^\s+-\s+["']?([\w./-]+)\/\*["']?\s*$/.exec(line)?.[1];
    if (!glob) throw new GateError(`pnpm-workspace.yaml: unsupported pattern ${JSON.stringify(line.trim())}`);
    const parent = path.join(ROOT, glob);
    if (!fs.existsSync(parent)) continue;
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(parent, entry.name, "package.json"))) {
        dirs.push(path.join(parent, entry.name));
      }
    }
  }
  return dirs.sort();
}

/** `tsc-rs -p <config> [--noEmit]` segments of a package script. */
function tscRsInvocations(script, where) {
  const found = [];
  for (const segment of (script ?? "").split("&&").map((s) => s.trim())) {
    const [cmd, ...args] = segment.split(/\s+/);
    if (cmd !== "tsc-rs") continue;
    let config;
    let noEmit = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-p" && args[i + 1]) config = args[++i];
      else if (args[i] === "--noEmit") noEmit = true;
      else
        throw new GateError(`${where}: tsc-rs flag ${args[i]} is not handled by scripts/ci/typescript6.mjs`);
    }
    if (!config) throw new GateError(`${where}: tsc-rs without -p <config>`);
    found.push({ config, noEmit });
  }
  return found;
}

function discoverProjects() {
  const check = [];
  const emit = [];
  for (const dir of workspacePackageDirs()) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const rel = path.relative(ROOT, dir);
    for (const inv of tscRsInvocations(pkg.scripts?.typecheck, `${rel} typecheck`)) {
      if (!inv.noEmit) throw new GateError(`${rel}: the typecheck script must pass --noEmit to tsc-rs`);
      check.push({ name: `${pkg.name} ${inv.config}`, dir, config: inv.config });
    }
    for (const inv of tscRsInvocations(pkg.scripts?.build, `${rel} build`)) {
      if (!inv.noEmit) emit.push({ name: pkg.name, dir, config: inv.config });
    }
  }
  return { check, emit };
}

function readConfig(project) {
  const file = path.join(project.dir, project.config);
  const parsed = ts.getParsedCommandLineOfConfigFile(
    file,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new GateError(`${file}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
      },
    },
  );
  if (!parsed) throw new GateError(`${file}: cannot be read`);
  return parsed.options;
}

// ---- running TypeScript 6 ------------------------------------------------------------------------

function tscBin(dir) {
  const pkgJson = createRequire(path.join(dir, "package.json")).resolve("typescript/package.json");
  const { version } = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
  return { bin: path.join(path.dirname(pkgJson), "bin", "tsc"), version };
}

function runTsc(dir, args) {
  const { bin } = tscBin(dir);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

async function pool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(MAX_PARALLEL, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(lanes);
  return results;
}

const seconds = (t0) => `${((performance.now() - t0) / 1000).toFixed(1)}s`;

// ---- comparison ----------------------------------------------------------------------------------

function listFiles(dir, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.posix.join(rel, e.name);
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else out.push(r);
  }
  return out.sort();
}

function normaliseTs6Js(text) {
  const applied = [];
  for (const n of NORMALISATIONS) {
    text = text.replace(n.pattern, (...m) => {
      applied.push(n.name);
      return n.replacement.replace(/\$(\d)/g, (_, i) => m[Number(i)]);
    });
  }
  return { text, applied };
}

/** Sorts type-literal property signatures and union members (bottom-up) with the TypeScript 6 API. */
function canonicalDts(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const show = (n) => printer.printNode(ts.EmitHint.Unspecified, n, sf);
  const byText = (a, b) => (show(a) < show(b) ? -1 : show(a) > show(b) ? 1 : 0);
  const transformer = (ctx) => {
    const visit = (node) => {
      node = ts.visitEachChild(node, visit, ctx);
      if (ts.isTypeLiteralNode(node)) {
        // Call, construct, method and index signatures keep their order (overload order matters).
        const others = node.members.filter((m) => !ts.isPropertySignature(m));
        const props = node.members.filter(ts.isPropertySignature).sort(byText);
        return ts.factory.updateTypeLiteralNode(node, ts.factory.createNodeArray([...others, ...props]));
      }
      if (ts.isUnionTypeNode(node)) {
        return ts.factory.updateUnionTypeNode(node, ts.factory.createNodeArray([...node.types].sort(byText)));
      }
      return node;
    };
    return (root) => ts.visitNode(root, visit);
  };
  const result = ts.transform(sf, [transformer]);
  const printed = printer.printFile(result.transformed[0]);
  result.dispose();
  return printed;
}

/** The first differing region of two texts, with context, as `-`/`+` lines. */
function firstDiff(expected, actual, context = 3, maxLines = 12) {
  const a = expected.split("\n");
  const b = actual.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA > start && endB > start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const lines = [`@@ line ${start + 1} @@`];
  for (let i = Math.max(0, start - context); i < start; i++) lines.push(`  ${a[i]}`);
  for (let i = start; i <= Math.min(endA, start + maxLines - 1); i++) lines.push(`- ${a[i]}`);
  if (endA - start + 1 > maxLines) lines.push(`- … ${endA - start + 1 - maxLines} more`);
  for (let i = start; i <= Math.min(endB, start + maxLines - 1); i++) lines.push(`+ ${b[i]}`);
  if (endB - start + 1 > maxLines) lines.push(`+ … ${endB - start + 1 - maxLines} more`);
  for (let i = endB + 1; i < Math.min(b.length, endB + 1 + context); i++) lines.push(`  ${b[i]}`);
  return lines.map((l) => `      ${l}`).join("\n");
}

function compareTrees(project, ts6Dir, distDir) {
  const problems = [];
  const stats = {
    files: 0,
    jsIdentical: 0,
    jsNormalised: 0,
    dtsIdentical: 0,
    dtsReordered: 0,
    maps: 0,
    other: 0,
  };
  const normalisations = new Map();
  const expected = listFiles(ts6Dir);
  const actual = listFiles(distDir);
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((f) => !actualSet.has(f));
  const extra = actual.filter((f) => !expectedSet.has(f));
  if (missing.length)
    problems.push(
      `missing from dist (TypeScript 6 emits them): ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ", …" : ""}`,
    );
  if (extra.length)
    problems.push(
      `only in dist (TypeScript 6 does not emit them; stale dist? rebuild): ${extra.slice(0, 20).join(", ")}${extra.length > 20 ? ", …" : ""}`,
    );
  for (const f of expected.filter((x) => actualSet.has(x))) {
    stats.files++;
    if (f.endsWith(".map")) {
      stats.maps++;
      continue;
    }
    const six = fs.readFileSync(path.join(ts6Dir, f), "utf8");
    const rs = fs.readFileSync(path.join(distDir, f), "utf8");
    if (f.endsWith(".d.ts")) {
      if (six === rs) {
        stats.dtsIdentical++;
        continue;
      }
      const [canonicalSix, canonicalRs] = [canonicalDts(f, six), canonicalDts(f, rs)];
      if (canonicalSix === canonicalRs) stats.dtsReordered++;
      else
        problems.push(
          `${f}: declarations differ beyond member order (canonical forms; TypeScript 6 -, tsc-rs dist +)\n${firstDiff(canonicalSix, canonicalRs)}`,
        );
    } else if (f.endsWith(".js")) {
      if (six === rs) {
        stats.jsIdentical++;
        continue;
      }
      const { text, applied } = normaliseTs6Js(six);
      if (text === rs) {
        stats.jsNormalised++;
        for (const n of applied) normalisations.set(n, (normalisations.get(n) ?? 0) + 1);
      } else {
        problems.push(
          `${f}: JavaScript differs after the allowlisted normalisations (TypeScript 6 normalised -, tsc-rs dist +)\n${firstDiff(text, rs)}`,
        );
      }
    } else {
      stats.other++;
      if (six !== rs) problems.push(`${f}: differs (TypeScript 6 -, tsc-rs dist +)\n${firstDiff(six, rs)}`);
    }
  }
  return { problems, stats, normalisations };
}

// ---- gates ---------------------------------------------------------------------------------------

async function check(projects) {
  console.log(
    `TypeScript ${tscBin(ROOT).version} --noEmit over ${projects.length} projects (${MAX_PARALLEL} at a time)`,
  );
  const results = await pool(projects, async (p) => {
    const t0 = performance.now();
    const r = await runTsc(p.dir, ["-p", p.config, "--noEmit"]);
    return { p, ...r, time: seconds(t0) };
  });
  let failed = 0;
  for (const r of results) {
    const ok = r.code === 0;
    if (!ok) failed++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${r.p.name} (${r.time})`);
    if (!ok) console.log(r.output.replace(/^/gm, "      "));
  }
  return failed === 0;
}

async function emitParity(projects) {
  console.log(
    `TypeScript ${tscBin(ROOT).version} emit parity with tsc-rs dist for ${projects.length} projects (${MAX_PARALLEL} at a time)`,
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blockforge-emit-parity-"));
  try {
    const results = await pool(projects, async (p) => {
      const t0 = performance.now();
      const options = readConfig(p);
      const unsupported = [
        "outFile",
        "declarationDir",
        "incremental",
        "composite",
        "tsBuildInfoFile",
        "emitDeclarationOnly",
      ].filter((k) => options[k]);
      if (!options.outDir || unsupported.length) {
        return {
          p,
          time: seconds(t0),
          problems: [
            `${p.config}: needs outDir and none of ${unsupported.join(", ") || "outFile/declarationDir/incremental/composite"}`,
          ],
        };
      }
      const distDir = options.outDir;
      if (!fs.existsSync(distDir))
        return {
          p,
          time: seconds(t0),
          problems: [`${path.relative(ROOT, distDir)} does not exist: run \`pnpm build\` first`],
        };
      const outDir = path.join(tmp, p.name.replace(/[^\w.-]+/g, "_"));
      const r = await runTsc(p.dir, ["-p", p.config, "--outDir", outDir]);
      if (r.code !== 0)
        return {
          p,
          time: seconds(t0),
          problems: [`TypeScript 6 emit failed (exit ${r.code}):\n${r.output.replace(/^/gm, "      ")}`],
        };
      return { p, time: seconds(t0), ...compareTrees(p, outDir, distDir) };
    });
    let failed = 0;
    for (const r of results) {
      const ok = r.problems.length === 0;
      if (!ok) failed++;
      const s = r.stats;
      const detail = s
        ? `${s.files} files: js ${s.jsIdentical} identical + ${s.jsNormalised} normalised, d.ts ${s.dtsIdentical} identical + ${s.dtsReordered} reordered, ${s.maps} maps by name${s.other ? `, ${s.other} other` : ""}`
        : "";
      const norm = r.normalisations?.size
        ? ` [${[...r.normalisations].map(([k, v]) => `${k} x${v}`).join(", ")}]`
        : "";
      console.log(`  ${ok ? "ok  " : "FAIL"} ${r.p.name} ${r.p.config} (${r.time}) ${detail}${norm}`);
      for (const problem of r.problems) console.log(`    - ${problem}`);
    }
    return failed === 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const mode = process.argv[2];
const t0 = performance.now();
try {
  const { check: checkProjects, emit: emitProjects } = discoverProjects();
  let ok;
  if (mode === "check") {
    if (!checkProjects.length) throw new GateError("no `tsc-rs -p … --noEmit` typecheck scripts found");
    ok = await check(checkProjects);
  } else if (mode === "emit-parity") {
    if (!emitProjects.length) throw new GateError("no `tsc-rs -p …` build scripts found");
    ok = await emitParity(emitProjects);
  } else {
    throw new GateError("usage: node scripts/ci/typescript6.mjs check | emit-parity");
  }
  console.log(`${ok ? "passed" : "FAILED"} in ${seconds(t0)}`);
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  if (!(err instanceof GateError)) throw err;
  console.error(`typescript6 ${mode ?? ""}: ${err.message}`);
  process.exitCode = 2;
}
