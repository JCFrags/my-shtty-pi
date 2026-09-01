export const DIRECTORY_ENTRY_LIMIT = 10_000;
export const PREVIEW_MAX_BYTES = 200 * 1024;
export const PREVIEW_MAX_LINES = 5_000;
export const INSERT_PER_FILE_MAX_BYTES = 100 * 1024;
export const INSERT_TOTAL_MAX_BYTES = 400 * 1024;
export const FILTER_MAX_ENTRIES = 50_000;
export const FILTER_MAX_RESULTS = 5_000;
export const REFRESH_INTERVAL_MS = 2_000;
export const TAB_WIDTH = 4;

export const HARD_EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "bower_components",
  ".cache",
  ".parcel-cache",
  ".turbo",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".vite",
  ".webpack",
  ".rollup.cache",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  ".gradle",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
]);
