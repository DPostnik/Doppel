#!/usr/bin/env node
// doppel up | shots | mirror [args]: runs the tool of that name from the
// project you are in (README.md).
import { spawn } from "node:child_process";
import path from "node:path";

const TOOLS = { up: "up.mjs", shots: "shots.mjs", mirror: "mirror.mjs" };
const [cmd, ...args] = process.argv.slice(2);
if (!TOOLS[cmd]) {
  console.log(`usage: doppel <command> [args]

  up <refA> <refB>                serve both versions (\`.\` = your checkout as it is)
  shots [--all-themes] [--pages /,/a]   screenshot diff of every page and size
  mirror [--selftest]             one window, A left and B right, input mirrored

Run it inside a git checkout that has a doppel.config.mjs.`);
  process.exit(cmd ? 2 : 0);
}
const here = path.dirname(new URL(import.meta.url).pathname);
const child = spawn(process.execPath, [path.join(here, TOOLS[cmd]), ...args], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
