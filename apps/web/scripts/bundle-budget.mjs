#!/usr/bin/env node
/**
 * Per-route bundle budget for the SPA.
 *
 * What a route costs on first load = the JS (gzip -9) of the static import closure of
 *   entry + the `_app` layout (shell) + the route's own chunks,
 * read from Vite's manifest. Lazy chunks (dynamic imports such as server tabs, CodeMirror, the
 * eggs rule engine) are not counted: they load on demand.
 *
 * Usage:
 *   node scripts/bundle-budget.mjs                 build into a temp dir with --manifest, then check
 *   node scripts/bundle-budget.mjs --dist dist     check an existing build (made with --manifest)
 *   node scripts/bundle-budget.mjs --budget 300    budget in KiB (default 300)
 * Exits 1 when the shell or any `_app` route is over budget, 2 on usage/build errors.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

class UsageError extends Error {}

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const budgetKiB = Number(opt("--budget") ?? 300);
if (!Number.isFinite(budgetKiB) || budgetKiB <= 0) {
  console.error("--budget must be a positive number of KiB");
  process.exit(2);
}

let dist = opt("--dist") ? resolve(opt("--dist")) : null;
let cleanup = null;
if (!dist) {
  dist = mkdtempSync(join(tmpdir(), "bf-bundle-"));
  cleanup = () => rmSync(dist, { recursive: true, force: true });
  try {
    // Vite's own API with the app's vite.config.ts (same plugins/conditions as `pnpm build`).
    const { build } = await import("vite");
    await build({
      root: appDir,
      logLevel: "error",
      build: { manifest: true, outDir: dist, emptyOutDir: true },
    });
  } catch (err) {
    cleanup();
    console.error("vite build failed:", err instanceof Error ? err.message : err);
    process.exit(2);
  }
}

try {
  const manifestPath = join(dist, ".vite", "manifest.json");
  if (!existsSync(manifestPath)) {
    // Not process.exit(): the finally block must still remove a temp build dir.
    throw new UsageError(`No manifest at ${manifestPath} (build with --manifest)`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const sizeCache = new Map();
  const gz = (file) => {
    if (!sizeCache.has(file))
      sizeCache.set(file, gzipSync(readFileSync(join(dist, file)), { level: 9 }).length);
    return sizeCache.get(file);
  };
  const closure = (keys) => {
    const seen = new Set();
    const walk = (k) => {
      if (seen.has(k) || !manifest[k]) return;
      seen.add(k);
      for (const i of manifest[k].imports ?? []) walk(i);
    };
    keys.forEach(walk);
    return seen;
  };
  const measure = (keys) => {
    const set = closure(keys);
    const files = new Set([...set].map((k) => manifest[k].file).filter((f) => f.endsWith(".js")));
    return { bytes: [...files].reduce((s, f) => s + gz(f), 0), chunks: files.size };
  };
  /** Manifest keys of one source file (the route module and its `?tsr-split=…` chunks). */
  const keysOf = (file) => Object.keys(manifest).filter((k) => k.split("?")[0] === file);

  const entry = Object.keys(manifest).filter((k) => manifest[k].isEntry);
  const shellKeys = [...entry, ...keysOf("src/routes/_app.tsx")];
  const routeFiles = [
    ...new Set(
      Object.keys(manifest)
        .map((k) => k.split("?")[0])
        .filter((f) => f.startsWith("src/routes/_app/") && /\.tsx?$/.test(f)),
    ),
  ].sort();
  const routePath = (file) => {
    const p = file
      .replace(/^src\/routes\/_app/, "")
      .replace(/\.tsx?$/, "")
      .replace(/\/index$/, "");
    return p === "" ? "/" : p;
  };

  const budget = budgetKiB * 1024;
  const rows = [
    { name: "entry (login/setup)", ...measure(entry), checked: false },
    { name: "shell (_app layout)", ...measure(shellKeys), checked: true },
    ...routeFiles.map((f) => ({
      name: routePath(f),
      ...measure([...shellKeys, ...keysOf(f)]),
      checked: true,
    })),
  ];
  const width = Math.max(...rows.map((r) => r.name.length));
  console.log(`Route JS on first load (gzip -9, entry + shell + route closure); budget ${budgetKiB} KiB\n`);
  let over = 0;
  for (const r of rows) {
    const kib = r.bytes / 1024;
    const bad = r.checked && r.bytes > budget;
    if (bad) over++;
    const status = !r.checked ? "" : bad ? "OVER" : "ok";
    console.log(
      `${r.name.padEnd(width)}  ${kib.toFixed(1).padStart(7)} KiB  ${String(r.chunks).padStart(3)} chunks  ${status}`,
    );
  }
  if (over) {
    console.error(`\n${over} route(s) over the ${budgetKiB} KiB budget.`);
    process.exitCode = 1;
  } else console.log(`\nAll routes within ${budgetKiB} KiB.`);
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  console.error(err.message);
  process.exitCode = 2;
} finally {
  cleanup?.();
}
