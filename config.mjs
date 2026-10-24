// Loads the project's doppel.config.mjs and fills in the defaults. Every
// tool here (up, shots, mirror) reads the project through this file only, so
// nothing else knows which framework or site it is looking at.
//
// The project is the git checkout you run a tool from (or --project <dir>);
// its config is <project>/doppel.config.mjs (or --config <file>).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULTS = {
  name: "",
  // Paths linked from your checkout into each worktree instead of installed
  // again (node_modules, a .env file...). Use `install` to install instead.
  link: ["node_modules"],
  install: null, // e.g. "npm ci"
  build: null, // e.g. "npm run build"; null = nothing to build
  start: null, // required: serves the app on $PORT, e.g. "npx next start -p $PORT"
  ready: "/", // path that answers once the server is up
  ports: [3141, 3142],
  env: {},
  pages: ["/"],
  sizes: [
    ["4k", 3840, 2160],
    ["2k", 2560, 1440],
    ["fullhd", 1920, 1080],
    ["tablet", 768, 1024],
    ["phone", 390, 844],
  ],
  // Query parameter that sets the theme, and its values; the first one is the
  // default. null if the site has no theme switch.
  theme: null, // e.g. { param: "theme", values: ["dark", "light"] }
  reducedMotion: true, // screenshots with prefers-reduced-motion: reduce
  selftest: null, // project checks for `mirror --selftest`, relative to the config
};

const argOf = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

// Options every tool takes: --project <dir>, --config <file>, and overrides
// for running several comparisons at once: --ports 3241,3242, --name <suffix>
// (worktree folder names).
const COMMON = ["--project", "--config", "--ports", "--name"];

/** Strips the common options (and their values) so tools see only their own
 *  arguments. */
export function ownArgs(argv) {
  return argv.filter((a, i) => !COMMON.includes(a) && !COMMON.includes(argv[i - 1]));
}

export async function loadConfig(argv = process.argv.slice(2)) {
  const from = argOf(argv, "--project") || process.cwd();
  let root;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: from, encoding: "utf8" }).trim();
  } catch {
    throw new Error(`doppel: ${from} is not inside a git checkout`);
  }
  const file = path.resolve(root, argOf(argv, "--config") || "doppel.config.mjs");
  if (!fs.existsSync(file)) throw new Error(`doppel: no ${path.relative(root, file)} in ${root}; see the Doppel README`);
  const user = (await import(pathToFileURL(file).href)).default;
  const c = { ...DEFAULTS, ...user };
  c.name ||= path.basename(root);
  if (argOf(argv, "--ports")) c.ports = argOf(argv, "--ports").split(",").map(Number);
  if (argOf(argv, "--name")) c.name += `-${argOf(argv, "--name")}`;
  if (!c.start) throw new Error(`doppel: ${file} has no \`start\` command`);
  c.root = root;
  c.file = file;
  c.urls = c.ports.map((p) => `http://localhost:${p}`);
  c.worktrees = ["a", "b"].map((s) => path.join(os.tmpdir(), `doppel-${c.name}-${s}`));
  c.out = path.join(root, ".doppel");
  if (c.selftest) c.selftest = path.resolve(path.dirname(file), c.selftest);
  return c;
}
