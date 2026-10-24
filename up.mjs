#!/usr/bin/env node
/**
 * Serve two versions of the project side by side, as production builds, for
 * mirror.mjs (manual check) and shots.mjs (screenshot diff).
 *
 *   doppel up <refA> <refB>     # e.g. origin/main .
 *
 * A ref is anything git understands; `.` is the current checkout including
 * uncommitted and untracked changes. Each version gets its own git worktree
 * (<tmp>/doppel-<name>-a and -b), with the config's `link` paths linked from
 * this checkout (or `install` run), is built with `build` and served with
 * `start` on the config's two ports. Logs: <worktree>.build.log, .serve.log.
 * Ctrl+C stops both. How to set a project up: README.md here.
 *
 *   --only b   rebuild and restart one side (a or b) and leave the other
 *              running as it is, e.g. after an edit: `doppel up --only b HEAD .`
 *              The mirror window keeps going and reloads that pane by itself.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, ownArgs } from "./config.mjs";

const c = await loadConfig();
const argv = ownArgs(process.argv.slice(2));
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const [refA, refB] = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--only");
if (!refA || !refB) {
  console.error("usage: doppel up <refA> <refB>   (`.` = current checkout)");
  process.exit(2);
}
const sides = [refA, refB].map((ref, i) => ({ name: "ab"[i], ref, port: c.ports[i], dir: c.worktrees[i] })).filter((s) => !only || s.name === only);
if (only && !sides.length) {
  console.error("--only takes a or b");
  process.exit(2);
}
// Free the port of a side being rebuilt (its old server may belong to an
// earlier `doppel up`). Only the process listening on it: `-a` ANDs the
// filters, else lsof also lists every client connected to the port (the
// mirror window, the other side's `up`) and they would be killed too.
for (const s of sides)
  try {
    execFileSync("sh", ["-c", `lsof -nP -a -iTCP:${s.port} -sTCP:LISTEN -t | xargs kill 2>/dev/null; true`]);
  } catch {}
const git = (args, cwd = c.root) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const sh = (cmd, cwd, env, log) =>
  new Promise((resolve, reject) => {
    const out = fs.openSync(log, "w");
    const p = spawn(cmd, { cwd, env, shell: true, stdio: ["ignore", out, out] });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`\`${cmd}\` failed in ${cwd}, see ${log}`))));
  });

function prepare(s) {
  const head = s.ref === "." ? "HEAD" : s.ref;
  const sha = git(["rev-parse", "--verify", head + "^{commit}"]);
  if (fs.existsSync(s.dir)) git(["worktree", "remove", "--force", s.dir]);
  git(["worktree", "prune"]);
  git(["worktree", "add", "--detach", s.dir, sha]);
  for (const p of c.link) if (fs.existsSync(path.join(c.root, p))) fs.symlinkSync(path.join(c.root, p), path.join(s.dir, p));
  if (s.ref === ".") {
    // Uncommitted edits, then untracked files, copied over as they are.
    const diff = execFileSync("git", ["diff", "HEAD", "--binary"], { cwd: c.root });
    if (diff.length) execFileSync("git", ["apply", "--whitespace=nowarn"], { cwd: s.dir, input: diff });
    for (const f of git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean)) {
      fs.mkdirSync(path.dirname(path.join(s.dir, f)), { recursive: true });
      fs.copyFileSync(path.join(c.root, f), path.join(s.dir, f));
    }
  }
  s.label = s.ref === "." ? `${sha.slice(0, 7)} + working tree` : `${s.ref} (${sha.slice(0, 7)})`;
  s.env = { ...process.env, ...c.env, PORT: String(s.port) };
}

async function waitUp(url) {
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not come up`);
}

for (const s of sides) prepare(s);
if (c.install) {
  console.log(`installing (${c.install})...`);
  await Promise.all(sides.map((s) => sh(c.install, s.dir, s.env, `${s.dir}.install.log`)));
}
if (c.build) {
  console.log(`building both versions (${c.build})...`);
  await Promise.all(sides.map((s) => sh(c.build, s.dir, s.env, `${s.dir}.build.log`)));
}

const servers = sides.map((s) => {
  const out = fs.openSync(`${s.dir}.serve.log`, "w");
  return spawn(c.start, { cwd: s.dir, env: s.env, shell: true, stdio: ["ignore", out, out], detached: true });
});
const stop = () => {
  for (const p of servers)
    try {
      process.kill(-p.pid);
    } catch {}
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.all(sides.map((s) => waitUp(`http://localhost:${s.port}${c.ready}`)));
for (const s of sides) console.log(`${s.name.toUpperCase()}  http://localhost:${s.port}   ${s.label}`);
console.log("\ndoppel mirror      # one window, A left and B right, your input mirrored");
console.log("doppel shots       # screenshot diff at every size");
console.log("Ctrl+C stops both servers.");
await new Promise(() => {});
