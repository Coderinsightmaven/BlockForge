import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TemplateImportPreview } from "@blockforge/contracts";
import { exportEgg, parseEgg } from "../src/index.js";

/**
 * Opt-in corpus run: `EGG_CORPUS_DIR=/path/to/eggs pnpm test` parses every `*.json` egg in the
 * directory (e.g. a checkout of pelican-eggs/*), checks the preview against the contract and the
 * export round trip. Error issues are allowed (the egg may be broken) but parsing must not throw.
 */
const DIR = process.env["EGG_CORPUS_DIR"];

describe.skipIf(!DIR)("egg corpus", () => {
  const files = DIR ? readdirSync(DIR).filter((f) => f.endsWith(".json")) : [];
  it.each(files)("%s", (f) => {
    const raw = JSON.parse(readFileSync(join(DIR!, f), "utf8")) as unknown;
    const p = parseEgg(raw, { category: "Corpus" });
    TemplateImportPreview.parse(p);
    if (p.template) {
      const again = parseEgg(JSON.parse(JSON.stringify(exportEgg(p.template))), { category: "Corpus", game: p.template.game });
      expect(again.template?.variables).toEqual(p.template.variables);
      expect(again.template?.configFiles).toEqual(p.template.configFiles);
    } else {
      console.warn(`[corpus] ${f}: ${p.issues.filter((i) => i.severity === "error").map((i) => i.code).join(", ")}`);
    }
  });
});
