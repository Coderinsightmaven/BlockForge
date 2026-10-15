#!/usr/bin/env node
// TypeScript 6 gates for the tsc-rs toolchain (docs/development/workflow.md, "Quality gates").
//
// `typecheck` and the `build` emit run tsc-rs (a port of the TypeScript 7 compiler), while ESLint,
// vitest, drizzle-kit and editors still use the `typescript` 6 package. These gates keep both honest:
//
//   node scripts/ci/typescript6.mjs check
//     Runs TypeScript 6 `tsc -p <config> --noEmit` over every project that a package script checks
//     with tsc-rs, so an error only TypeScript 6 reports cannot reach main.
//
//   node scripts/ci/typescript6.mjs emit-parity      (after `pnpm build`)
//     Emits every project that a package's `build` script emits with tsc-rs again, with TypeScript 6,
//     into a temporary directory (`dist` is not touched), and compares the result with `dist`:
//       - the emitted file lists must be identical;
//       - every .js file must be byte-identical after the allowlisted normalisations below;
//       - every .d.ts file must parse without syntax errors (both compilers' output) and be
//         byte-identical, or identical after sorting the property signatures of each type literal
//         and the members of each union, bottom-up (order carries no meaning in either; tsc 7 orders
//         them differently). Nothing else is reordered or ignored: interfaces, classes, overloads,
//         tuples, type parameters, parameters, enums, modifiers, statements and comments must match;
//       - every .js.map must be valid version-3 JSON with the same `file`, the same `names` and the
//         same `sources` (resolved against each map's directory and `sourceRoot`). `mappings` is not
//         compared: tsc 7 maps compiler-written code (parameter properties, default parameters, some
//         `case` blocks) at coarser positions and omits `sourceRoot: ""`.
//
//   node scripts/ci/typescript6.mjs selftest
//     Checks the comparisons and the project discovery of this script against fixed cases.
//
// Allowlisted .js normalisations (applied to the TypeScript 6 output only, line-anchored, exact):
//   EMPTY_NAMED_IMPORT  `import X, {} from "m";` -> `import X from "m";`
//     TypeScript 6 keeps the empty braces when every named import was type-only; tsc 7 drops them.
//     Both import the default binding only and evaluate the module the same way.
//
// Projects are found from the scripts of every workspace package (`pnpm ls -r`): each `tsc-rs -p
// <config> [--noEmit]` command in `typecheck` or `build`. Any other use of `tsc-rs` in any script
// (another script name, another flag, a wrapper such as `cross-env` or `pnpm exec`) fails the gate
// until it is handled here, so no project is skipped silently.
import { execFileSync, spawn } from "node:child_process";
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

/** Every workspace package (root included), as pnpm itself resolves `pnpm-workspace.yaml`. */
function workspacePackages(root) {
  const execPath = process.env.npm_execpath;
  const [cmd, ...pre] =
    execPath && /pnpm/.test(execPath)
      ? /\.[cm]?js$/.test(execPath)
        ? [process.execPath, execPath]
        : [execPath]
      : ["pnpm"];
  let out;
  try {
    out = execFileSync(cmd, [...pre, "ls", "-r", "--depth", "-1", "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new GateError(`\`pnpm ls -r\` failed in ${root}: ${err.stderr || err.message}`);
  }
  const list = JSON.parse(out);
  if (!Array.isArray(list) || list.length === 0) throw new GateError("`pnpm ls -r` listed no packages");
  return list
    .map((p) => ({ name: p.name, dir: fs.realpathSync(p.path) }))
    .sort((a, b) => (a.dir < b.dir ? -1 : 1));
}

/**
 * The tsc-rs commands of one package's scripts. Every command (split on `&&`, `||`, `;`, `&`, `|` and
 * newlines) that mentions tsc-rs must be exactly `tsc-rs -p <config> [--noEmit]` in `typecheck` or
 * `build`; anything else throws.
 */
function parseScripts(pkgName, scripts) {
  const check = [];
  const emit = [];
  for (const [script, text] of Object.entries(scripts ?? {})) {
    for (const command of String(text)
      .split(/&&|\|\||[;&|\n]/)
      .map((s) => s.trim())) {
      if (!/tsc-rs/.test(command)) continue;
      const where = `${pkgName} script "${script}": \`${command}\``;
      const [cmd, ...args] = command.split(/\s+/);
      if (cmd !== "tsc-rs") throw new GateError(`${where}: tsc-rs in a form this gate does not parse`);
      if (script !== "typecheck" && script !== "build") {
        throw new GateError(`${where}: tsc-rs outside the typecheck and build scripts is not covered`);
      }
      let config;
      let noEmit = false;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "-p" && args[i + 1]) config = args[++i];
        else if (args[i] === "--noEmit") noEmit = true;
        else throw new GateError(`${where}: flag ${args[i]} is not handled by scripts/ci/typescript6.mjs`);
      }
      if (!config) throw new GateError(`${where}: no -p <config>`);
      if (script === "typecheck" && !noEmit) throw new GateError(`${where}: typecheck must pass --noEmit`);
      (noEmit ? check : emit).push(config);
    }
  }
  return { check, emit };
}

function discoverProjects(root) {
  const check = new Map();
  const emit = [];
  for (const { name, dir } of workspacePackages(root)) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const found = parseScripts(name ?? path.relative(root, dir), pkg.scripts);
    for (const config of found.check)
      check.set(`${dir}\0${config}`, { name: `${name} ${config}`, dir, config });
    for (const config of found.emit) emit.push({ name: `${name} ${config}`, dir, config });
  }
  return { check: [...check.values()], emit };
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

/** Runs `worker` over `items`, MAX_PARALLEL at a time; waits for every item, even after a failure. */
async function pool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(MAX_PARALLEL, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await worker(items[i]);
      } catch (err) {
        results[i] = { item: items[i], error: err };
      }
    }
  });
  await Promise.allSettled(lanes);
  return results;
}

const seconds = (t0) => `${((performance.now() - t0) / 1000).toFixed(1)}s`;

// ---- comparisons ---------------------------------------------------------------------------------

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

/** Syntax errors of a declaration file (the parser recovers from them, so they must be asked for). */
function syntaxErrors(file, text) {
  const name = file.endsWith(".d.ts") ? file : `${file}.d.ts`;
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const host = {
    getSourceFile: (n) => (n === name ? sf : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => f === name,
    readFile: () => undefined,
  };
  const program = ts.createProgram({
    rootNames: [name],
    options: { noLib: true, noResolve: true, types: [] },
    host,
  });
  return program.getSyntacticDiagnostics(sf).map((d) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    return `${line + 1}:${character + 1} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
  });
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

/**
 * Every comment (JSDoc, triple-slash directives, line comments) of a file, sorted. The printer can drop
 * a comment that sits in a single-line type literal, so a reordering must also keep this multiset.
 */
function commentMultiset(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const comments = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      comments.push(scanner.getTokenText());
    }
  }
  return comments.sort();
}

/** Compares a TypeScript 6 declaration file with the tsc-rs one: identical, reordered or a problem. */
function compareDts(file, six, rs) {
  for (const [who, text] of [
    ["tsc-rs", rs],
    ["TypeScript 6", six],
  ]) {
    const errors = syntaxErrors(file, text);
    if (errors.length)
      return { kind: "problem", detail: `${who} output has syntax errors: ${errors.join("; ")}` };
  }
  if (six === rs) return { kind: "identical" };
  const [a, b] = [canonicalDts(file, six), canonicalDts(file, rs)];
  if (a === b) {
    const [ca, cb] = [commentMultiset(six), commentMultiset(rs)];
    if (JSON.stringify(ca) === JSON.stringify(cb)) return { kind: "reordered" };
    const count = (list) => list.reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map());
    const only = (x, y) => {
      const [mx, my] = [count(x), count(y)];
      return [...mx]
        .filter(([c, n]) => n > (my.get(c) ?? 0))
        .map(([c, n]) => `${JSON.stringify(c)} x${n - (my.get(c) ?? 0)}`);
    };
    return {
      kind: "problem",
      detail: `comments differ (TypeScript 6 only: ${only(ca, cb).join(", ") || "-"}; tsc-rs only: ${only(cb, ca).join(", ") || "-"})`,
    };
  }
  return {
    kind: "problem",
    detail: `declarations differ beyond member order (canonical forms; TypeScript 6 -, tsc-rs dist +)\n${firstDiff(a, b)}`,
  };
}

/** Compares source map metadata (not `mappings`); `sixPath`/`rsPath` locate each map for `sources`. */
function compareMap(sixText, rsText, sixPath, rsPath) {
  const parse = (text, who) => {
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new GateError(`${who} map is not valid JSON: ${err.message}`);
    }
  };
  try {
    const six = parse(sixText, "TypeScript 6");
    const rs = parse(rsText, "tsc-rs");
    for (const [who, m] of [
      ["TypeScript 6", six],
      ["tsc-rs", rs],
    ]) {
      if (m.version !== 3) return `${who} map has version ${JSON.stringify(m.version)}, not 3`;
      if (typeof m.mappings !== "string" || !Array.isArray(m.sources) || !Array.isArray(m.names)) {
        return `${who} map lacks mappings, sources or names`;
      }
    }
    if (six.file !== rs.file)
      return `file differs: ${JSON.stringify(six.file)} vs ${JSON.stringify(rs.file)}`;
    if (JSON.stringify(six.names) !== JSON.stringify(rs.names)) return "names differ";
    const resolve = (m, mapPath) =>
      m.sources.map((s) => path.resolve(path.dirname(mapPath), m.sourceRoot ?? "", s));
    const [a, b] = [resolve(six, sixPath), resolve(rs, rsPath)];
    if (JSON.stringify(a) !== JSON.stringify(b)) return `sources differ: ${a.join(", ")} vs ${b.join(", ")}`;
    return undefined;
  } catch (err) {
    if (err instanceof GateError) return err.message;
    throw err;
  }
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

function compareTrees(ts6Dir, distDir) {
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
  const list = (files) => `${files.slice(0, 20).join(", ")}${files.length > 20 ? ", …" : ""}`;
  const missing = expected.filter((f) => !actualSet.has(f));
  const extra = actual.filter((f) => !expectedSet.has(f));
  if (missing.length) problems.push(`missing from dist (TypeScript 6 emits them): ${list(missing)}`);
  if (extra.length)
    problems.push(`only in dist (TypeScript 6 does not emit them; stale dist? rebuild): ${list(extra)}`);
  for (const f of expected.filter((x) => actualSet.has(x))) {
    stats.files++;
    const six = fs.readFileSync(path.join(ts6Dir, f), "utf8");
    const rs = fs.readFileSync(path.join(distDir, f), "utf8");
    if (f.endsWith(".map")) {
      stats.maps++;
      const problem = compareMap(six, rs, path.join(ts6Dir, f), path.join(distDir, f));
      if (problem) problems.push(`${f}: ${problem}`);
    } else if (f.endsWith(".d.ts")) {
      const r = compareDts(f, six, rs);
      if (r.kind === "identical") stats.dtsIdentical++;
      else if (r.kind === "reordered") stats.dtsReordered++;
      else problems.push(`${f}: ${r.detail}`);
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
  for (const [i, r] of results.entries()) {
    const ok = !r.error && r.code === 0;
    if (!ok) failed++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${projects[i].name}${r.time ? ` (${r.time})` : ""}`);
    if (r.error) console.log(`      ${r.error.message}`);
    else if (!ok) console.log(r.output.replace(/^/gm, "      "));
  }
  return failed === 0;
}

async function emitParity(projects) {
  console.log(
    `TypeScript ${tscBin(ROOT).version} emit parity with tsc-rs dist for ${projects.length} projects (${MAX_PARALLEL} at a time)`,
  );
  // Read and validate every config before anything runs, so a bad config cannot leave a TypeScript 6
  // emit writing into a temporary directory that is being removed.
  const unsupportedKeys = [
    "outFile",
    "declarationDir",
    "incremental",
    "composite",
    "tsBuildInfoFile",
    "emitDeclarationOnly",
  ];
  const jobs = projects.map((p) => {
    const options = readConfig(p);
    const unsupported = unsupportedKeys.filter((k) => options[k]);
    if (!options.outDir || unsupported.length) {
      throw new GateError(
        `${p.name}: needs outDir and none of ${unsupportedKeys.join(", ")} (has ${unsupported.join(", ") || "no outDir"})`,
      );
    }
    if (!fs.existsSync(options.outDir)) {
      throw new GateError(`${path.relative(ROOT, options.outDir)} does not exist: run \`pnpm build\` first`);
    }
    return { p, distDir: options.outDir, slug: `${p.name}`.replace(/[^\w.-]+/g, "_") };
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blockforge-emit-parity-"));
  try {
    const results = await pool(jobs, async ({ p, distDir, slug }) => {
      const t0 = performance.now();
      const outDir = path.join(tmp, slug);
      const r = await runTsc(p.dir, ["-p", p.config, "--outDir", outDir]);
      if (r.code !== 0) {
        return {
          time: seconds(t0),
          problems: [`TypeScript 6 emit failed (exit ${r.code}):\n${r.output.replace(/^/gm, "      ")}`],
        };
      }
      return { time: seconds(t0), ...compareTrees(outDir, distDir) };
    });
    let failed = 0;
    for (const [i, r] of results.entries()) {
      const problems = r.error ? [r.error.message] : r.problems;
      const ok = problems.length === 0;
      if (!ok) failed++;
      const s = r.stats;
      const detail = s
        ? `${s.files} files: js ${s.jsIdentical} identical + ${s.jsNormalised} normalised, d.ts ${s.dtsIdentical} identical + ${s.dtsReordered} reordered, ${s.maps} maps${s.other ? `, ${s.other} other` : ""}`
        : "";
      const norm = r.normalisations?.size
        ? ` [${[...r.normalisations].map(([k, v]) => `${k} x${v}`).join(", ")}]`
        : "";
      console.log(
        `  ${ok ? "ok  " : "FAIL"} ${jobs[i].p.name}${r.time ? ` (${r.time})` : ""} ${detail}${norm}`,
      );
      for (const problem of problems) console.log(`    - ${problem}`);
    }
    return failed === 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- selftest ------------------------------------------------------------------------------------

function selftest() {
  let failures = 0;
  const report = (ok, name, extra = "") => {
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  };

  console.log("EMPTY_NAMED_IMPORT normalisation");
  const imports = [
    ['import X, {} from "m";', 'import X from "m";'],
    ["import X, {} from 'm';", "import X from 'm';"],
    ['import $x_1, {} from "@scope/m/sub.js";', 'import $x_1 from "@scope/m/sub.js";'],
    ['import X, { Y } from "m";', null],
    ['import X, {} from "m"; // c', null],
    ['  import X, {} from "m";', null],
    ['import {} from "m";', null],
    ['import * as X, {} from "m";', null],
    ['export X, {} from "m";', null],
    ['import X, {}from "m";', null],
    ['import X, {} from "m"', null],
  ];
  for (const [input, expected] of imports) {
    const out = normaliseTs6Js(input).text;
    report(out === (expected ?? input), JSON.stringify(input), `-> ${JSON.stringify(out)}`);
  }

  console.log(".d.ts comparison (TypeScript 6 output vs tsc-rs output)");
  const dts = [
    // Must pass.
    [
      "pass",
      "property reordering",
      "export type T = { a: string; b: number };",
      "export type T = { b: number; a: string };",
    ],
    ["pass", "union reordering", 'export type U = "a" | "b" | "c";', 'export type U = "c" | "a" | "b";'],
    [
      "pass",
      "nested property and union reordering",
      'export type T = { k: "x" | "y"; j: { m: 1 | 2; n: string } };',
      'export type T = { j: { n: string; m: 2 | 1 }; k: "y" | "x" };',
    ],
    [
      "pass",
      "reordering inside a type argument",
      'export declare const E: Z<{ a: "a"; b: "b" }>;',
      'export declare const E: Z<{ b: "b"; a: "a" }>;',
    ],
    [
      "pass",
      "JSDoc moves with its property (members on their own lines, as tsc emits them)",
      "export type T = {\n    /** A */\n    a: string;\n    b: number;\n};\n",
      "export type T = {\n    b: number;\n    /** A */\n    a: string;\n};\n",
    ],
    // Must fail.
    [
      "fail",
      "property moved between nested types",
      "export type T = { a: { x: string }; b: {} };",
      "export type T = { a: {}; b: { x: string } };",
    ],
    [
      "fail",
      "shifted union duplicates",
      'export type U = "a" | "a" | "b";',
      'export type U = "a" | "b" | "b";',
    ],
    [
      "fail",
      "call signature order",
      "export type F = { (x: string): string; (x: number): number };",
      "export type F = { (x: number): number; (x: string): string };",
    ],
    [
      "fail",
      "method overload order",
      "export type M = { m(x: string): string; m(x: number): number };",
      "export type M = { m(x: number): number; m(x: string): string };",
    ],
    [
      "fail",
      "construct signature order",
      "export type C = { new (x: string): object; new (x: number): Date };",
      "export type C = { new (x: number): Date; new (x: string): object };",
    ],
    [
      "fail",
      "function overload order",
      "export declare function f(x: string): string;\nexport declare function f(x: number): number;",
      "export declare function f(x: number): number;\nexport declare function f(x: string): string;",
    ],
    [
      "fail",
      "interface member order",
      "export interface I { a: string; b: number }",
      "export interface I { b: number; a: string }",
    ],
    ["fail", "tuple order", "export type T = [string, number];", "export type T = [number, string];"],
    [
      "fail",
      "type parameter order",
      "export declare function g<A, B>(a: A, b: B): void;",
      "export declare function g<B, A>(a: A, b: B): void;",
    ],
    [
      "fail",
      "parameter order",
      "export declare function h(a: string, b: number): void;",
      "export declare function h(b: number, a: string): void;",
    ],
    [
      "fail",
      "enum member order",
      "export declare enum E { A = 0, B = 1 }",
      "export declare enum E { B = 1, A = 0 }",
    ],
    [
      "fail",
      "enum value",
      "export declare enum E { A = 0, B = 1 }",
      "export declare enum E { A = 0, B = 2 }",
    ],
    ["fail", "optional modifier", "export type T = { a?: string };", "export type T = { a: string };"],
    [
      "fail",
      "readonly modifier",
      "export type T = { readonly a: string };",
      "export type T = { a: string };",
    ],
    ["fail", "dropped export {}", "declare const x: number;\nexport {};\n", "declare const x: number;\n"],
    [
      "fail",
      "triple-slash directive",
      '/// <reference types="node" />\nexport declare const x: number;\n',
      '/// <reference types="vite/client" />\nexport declare const x: number;\n',
    ],
    [
      "fail",
      "JSDoc text",
      "/** Adds. */\nexport declare function f(): void;\n",
      "/** Removes. */\nexport declare function f(): void;\n",
    ],
    [
      "fail",
      "JSDoc moved to another property",
      "export type T = {\n    /** doc */\n    a: string;\n    b: number;\n};\n",
      "export type T = {\n    a: string;\n    /** doc */\n    b: number;\n};\n",
    ],
    [
      "fail",
      "JSDoc moved to another property in a single-line literal",
      "export type T = { /** doc */ a: string; b: number };",
      "export type T = { a: string; /** doc */ b: number };",
    ],
    [
      "fail",
      "JSDoc dropped from a single-line literal",
      "export type T = { /** doc */ a: string; b: number };",
      "export type T = { b: number; a: string };",
    ],
    [
      "fail",
      "duplicated comment",
      "/** A */\nexport declare const x: number;\n",
      "/** A */\n/** A */\nexport declare const x: number;\n",
    ],
    [
      "fail",
      "stray } in tsc-rs output",
      "export declare const x: number;\n",
      "export declare const x: number;\n}\n",
    ],
    [
      "fail",
      "stray } with a reordering",
      "export type T = { a: string; b: number };\n",
      "export type T = { b: number; a: string };\n}\n",
    ],
    [
      "fail",
      "stray } in TypeScript 6 output",
      "export declare const x: number;\n}\n",
      "export declare const x: number;\n}\n",
    ],
  ];
  for (const [expect, name, six, rs] of dts) {
    const r = compareDts("case.d.ts", six, rs);
    const passed = r.kind !== "problem";
    report(
      passed === (expect === "pass"),
      `${expect === "pass" ? "passes" : "fails"}: ${name}`,
      r.kind === "problem" ? r.detail.split("\n")[0] : r.kind,
    );
  }

  console.log("source map metadata");
  const map = (extra) =>
    JSON.stringify({
      version: 3,
      file: "a.js",
      sourceRoot: "",
      sources: ["../src/a.ts"],
      names: [],
      mappings: "AAAA",
      ...extra,
    });
  const maps = [
    [
      "pass",
      "sourceRoot omitted, other mappings",
      map(),
      JSON.stringify({ version: 3, file: "a.js", sources: ["../src/a.ts"], names: [], mappings: "AACA" }),
    ],
    // TypeScript 6 writes its map into a temporary directory, so its relative `sources` differ.
    [
      "pass",
      "same sources resolved from another directory",
      map({ sources: ["../../x/src/a.ts"] }),
      map(),
      "/r/tmp/a",
    ],
    ["fail", "another source file", map(), map({ sources: ["../src/b.ts"] })],
    ["fail", "same relative sources from another directory", map(), map(), "/r/tmp/a"],
    ["fail", "another file", map(), map({ file: "b.js" })],
    ["fail", "other names", map(), map({ names: ["x"] })],
    ["fail", "version 2", map(), map({ version: 2 })],
    ["fail", "invalid JSON", map(), "{"],
  ];
  for (const [expect, name, six, rs, sixDir = "/r/x/dist", rsDir = "/r/x/dist"] of maps) {
    const problem = compareMap(six, rs, path.join(sixDir, "a.js.map"), path.join(rsDir, "a.js.map"));
    report(
      !problem === (expect === "pass"),
      `${expect === "pass" ? "passes" : "fails"}: ${name}`,
      problem ?? "ok",
    );
  }

  console.log("project discovery");
  const scripts = [
    [
      "ok",
      "`;`-composed commands",
      { typecheck: "tsc-rs -p a.json --noEmit; tsc-rs -p b.json --noEmit" },
      "check=a.json,b.json emit=",
    ],
    [
      "ok",
      "build emit and build check",
      { build: "tsc-rs -p tsconfig.build.json && tsc-rs -p c.json --noEmit && vite build" },
      "check=c.json emit=tsconfig.build.json",
    ],
    [
      "ok",
      "no tsc-rs at all",
      { test: "vitest run", typecheck: "tsc -p tsconfig.json --noEmit" },
      "check= emit=",
    ],
    ["throws", "wrapped in cross-env", { typecheck: "cross-env X=1 tsc-rs -p a.json --noEmit" }],
    ["throws", "via pnpm exec", { typecheck: "pnpm exec tsc-rs -p a.json --noEmit" }],
    ["throws", "another script name", { check: "tsc-rs -p a.json --noEmit" }],
    ["throws", "an unknown flag", { typecheck: "tsc-rs -p a.json --noEmit --fast" }],
    ["throws", "typecheck without --noEmit", { typecheck: "tsc-rs -p a.json" }],
    ["throws", "no -p", { build: "tsc-rs" }],
    ["throws", "after ||", { build: "false || tsc-rs -p a.json --watch" }],
  ];
  for (const [expect, name, s, want] of scripts) {
    let got;
    try {
      const r = parseScripts("pkg", s);
      got = `check=${r.check.join(",")} emit=${r.emit.join(",")}`;
    } catch (err) {
      if (!(err instanceof GateError)) throw err;
      got = `throws: ${err.message}`;
    }
    report(expect === "throws" ? got.startsWith("throws") : got === want, name, got);
  }
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "blockforge-ts6-selftest-"));
  try {
    const write = (rel, content) => {
      fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
      fs.writeFileSync(path.join(ws, rel), content);
    };
    write("package.json", JSON.stringify({ name: "root", private: true }));
    write(
      "pnpm-workspace.yaml",
      'packages:\n  - "apps/*"\n  # libraries below\n\n  - packages/* # trailing comment\n',
    );
    write(
      "apps/a/package.json",
      JSON.stringify({ name: "a", scripts: { typecheck: "tsc-rs -p tsconfig.json --noEmit" } }),
    );
    write(
      "packages/b/package.json",
      JSON.stringify({ name: "b", scripts: { build: "tsc-rs -p tsconfig.build.json" } }),
    );
    const found = discoverProjects(ws);
    const got = `check=${found.check.map((p) => p.name).join(",")} emit=${found.emit.map((p) => p.name).join(",")}`;
    report(
      got === "check=a tsconfig.json emit=b tsconfig.build.json",
      "commented and spaced pnpm-workspace.yaml",
      got,
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log(failures ? `${failures} selftest case(s) failed` : "all selftest cases passed");
  return failures === 0;
}

// ---- main ----------------------------------------------------------------------------------------

const mode = process.argv[2];
const t0 = performance.now();
try {
  let ok;
  if (mode === "selftest") {
    ok = selftest();
  } else if (mode === "check" || mode === "emit-parity") {
    const projects = discoverProjects(ROOT);
    if (mode === "check") {
      if (!projects.check.length) throw new GateError("no `tsc-rs -p … --noEmit` scripts found");
      ok = await check(projects.check);
    } else {
      if (!projects.emit.length) throw new GateError("no `tsc-rs -p …` build scripts found");
      ok = await emitParity(projects.emit);
    }
  } else {
    throw new GateError("usage: node scripts/ci/typescript6.mjs check | emit-parity | selftest");
  }
  console.log(`${ok ? "passed" : "FAILED"} in ${seconds(t0)}`);
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  if (!(err instanceof GateError)) throw err;
  console.error(`typescript6 ${mode ?? ""}: ${err.message}`);
  process.exitCode = 2;
}
