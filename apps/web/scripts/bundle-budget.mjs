#!/usr/bin/env node
/**
 * Per-route bundle budget for the SPA.
 *
 * What a route costs on first load = the JS (gzip -9) of the static import closure of
 *   entry + the `_app` layout (shell) + the route's own chunks,
 * read from Vite's manifest.
 *
 * Variants: whatever the route module loads on demand itself (its tabs, settings cards, banners) can
 * be part of a first load too — a link straight to `/servers/x?tab=players` loads the Players tab
 * before anything else. So every dynamic import of the route's own chunks is measured as well, as
 * `route#name` = route closure ∪ the static closure of that chunk. The further dynamic imports of
 * those chunks (the uPlot chart, CodeMirror, the eggs rule engine, dialogs opened by a click) are not
 * counted: they load after the first paint and render as loading meanwhile. A `*-tab.tsx` chunk that
 * no route imports directly is an error (it would escape the budget).
 *
 * Usage:
 *   node scripts/bundle-budget.mjs                 build into a temp dir with --manifest, then check
 *   node scripts/bundle-budget.mjs --dist dist     check an existing build (made with --manifest)
 *   node scripts/bundle-budget.mjs --budget 300    budget in KiB (default 300)
 * Exits 1 when the shell, any `_app` route or any route variant is over budget, 2 on usage/build
 * errors.
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

  /** "src/features/servers/players/players-tab.tsx" → "players"; "_metric-chart-AbC123xy.js" → "metric-chart". */
  const variantName = (key) =>
    key
      .split("?")[0]
      .split("/")
      .pop()
      .replace(/^_/, "")
      .replace(/-[\w-]{8}\.js$/, "")
      .replace(/\.[jt]sx?$/, "")
      .replace(/-tab$/, "");

  const budget = budgetKiB * 1024;
  const rows = [
    { name: "entry (login/setup)", ...measure(entry), checked: false },
    { name: "shell (_app layout)", ...measure(shellKeys), checked: true },
  ];
  const covered = new Set();
  for (const f of routeFiles) {
    const routeKeys = keysOf(f);
    rows.push({ name: routePath(f), ...measure([...shellKeys, ...routeKeys]), checked: true });
    const lazyKeys = [...new Set(routeKeys.flatMap((k) => manifest[k].dynamicImports ?? []))].sort((a, b) =>
      variantName(a).localeCompare(variantName(b)),
    );
    for (const k of lazyKeys) {
      covered.add(k);
      rows.push({
        name: `${routePath(f)}#${variantName(k)}`,
        ...measure([...shellKeys, ...routeKeys, k]),
        checked: true,
        variant: true,
      });
    }
  }
  const strayTabs = Object.keys(manifest).filter(
    (k) => /-tab\.tsx$/.test(k.split("?")[0]) && manifest[k].isDynamicEntry && !covered.has(k),
  );
  if (strayTabs.length)
    throw new UsageError(
      `Tab chunks not imported by any route chunk (their first load is not budgeted): ${strayTabs.join(", ")}`,
    );

  const width = Math.max(...rows.map((r) => r.name.length));
  console.log(
    `Route JS on first load (gzip -9, entry + shell + route closure; route#x adds the route's lazy chunk x); budget ${budgetKiB} KiB\n`,
  );
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
    console.error(`\n${over} route(s)/variant(s) over the ${budgetKiB} KiB budget.`);
    process.exitCode = 1;
  } else console.log(`\nAll routes and variants within ${budgetKiB} KiB.`);
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  console.error(err.message);
  process.exitCode = 2;
} finally {
  cleanup?.();
}
