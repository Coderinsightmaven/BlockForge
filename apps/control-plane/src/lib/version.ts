import { readFileSync } from "node:fs";

/** The control-plane version from package.json (src/lib → ../../package.json, same depth in dist/). */
export const APP_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/.test(pkg.version) ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
