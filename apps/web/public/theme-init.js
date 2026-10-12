// Runs synchronously before the SPA boots so the first paint uses the right theme.
// Keep the storage key in sync with src/lib/theme.tsx.
(function () {
  try {
    var pref = localStorage.getItem("blockforge.theme");
    var dark =
      pref === "dark" ||
      ((pref === null || pref === "system") && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch (_e) {
    /* storage unavailable: fall back to light */
  }
})();
