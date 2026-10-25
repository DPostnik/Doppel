#!/usr/bin/env node
/**
 * Two versions of the project side by side in one window (mirror-app/, an
 * Electron app). Whatever you do in the left pane (A) is replayed in the right
 * one (B) as real input: mouse moves, clicks, wheel, keys, page scroll and
 * address changes, so hover, :focus-visible and :active behave as if you used
 * B yourself. The toolbar sets both panes to a screen size (scaled to fit),
 * the theme or an address, opens DevTools under either pane, and goes back,
 * forward or reloads both.
 *
 *   doppel mirror [urlA] [urlB] [path]
 *   defaults: the config's two ports, /
 *   --selftest   drive A, check B followed (generic checks, then the config's
 *                `selftest` file), print the results and quit
 *
 * Each run writes a crash log (pane and process crashes, uncaught errors,
 * memory once a minute, Chromium's full stderr, how it ended) to
 * ~/Library/Logs/Doppel/mirror-<time>.log; the last 30 are kept.
 *
 * Start the two versions first with up.mjs. Input is replayed by position, so
 * if the layouts differ, a click in B lands where the element was in A: that
 * mismatch is itself the finding.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadConfig, ownArgs } from "./config.mjs";

// fileURLToPath decodes %20 and non-ASCII; .pathname would not find node_modules.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "mirror-app");
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
// npm does not always run Electron's postinstall (the binary download). Say
// what is being done to Doppel's own node_modules, and if it fails (no
// network, say) print the commands instead of a stack trace.
let electron;
try {
  if (!fs.existsSync(path.join(HERE, "node_modules/electron/dist"))) {
    console.log(`doppel: Electron binary missing, running npm install in ${HERE}`);
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: HERE, stdio: "inherit" });
    execFileSync(process.execPath, ["node_modules/electron/install.js"], { cwd: HERE, stdio: "inherit" });
  }
  electron = createRequire(path.join(HERE, "package.json"))("electron");
} catch (e) {
  console.error(`doppel: could not install Electron (${e.message.split("\n")[0]})
run: cd ${q(HERE)} && npm install && node node_modules/electron/install.js`);
  process.exit(1);
}
electron = macBundle(electron);

// macOS takes the Dock and menu-bar name from the app bundle, not from the
// running app, so an unpackaged Electron shows up as "Electron". Run a copy
// of Electron.app renamed to Doppel instead; it is rebuilt when Electron
// changes. The copy is an APFS clone where possible, so it costs no space.
function macBundle(bin) {
  if (process.platform !== "darwin") return bin;
  const src = bin.replace(/\/Contents\/MacOS\/[^/]+$/, "");
  const dst = path.join(HERE, "node_modules/.doppel/Doppel.app");
  const exe = path.join(dst, "Contents/MacOS", path.basename(bin));
  const plist = path.join(dst, "Contents/Info.plist");
  const version = (p) => {
    try {
      return execFileSync("plutil", ["-extract", "CFBundleVersion", "raw", p], { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  if (fs.existsSync(exe) && version(plist) === version(path.join(src, "Contents/Info.plist"))) return exe;
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    execFileSync("cp", ["-cR", src, dst]);
  } catch {
    execFileSync("cp", ["-R", src, dst]);
  }
  for (const key of ["CFBundleName", "CFBundleDisplayName"])
    execFileSync("plutil", ["-replace", key, "-string", "Doppel", plist]);
  execFileSync("plutil", ["-replace", "CFBundleIdentifier", "-string", "com.dpostnik.doppel", plist]);
  // The edited Info.plist breaks Electron's ad-hoc signature; sign it again.
  // On failure show codesign's own reason, and drop the copy so the next run
  // builds it again instead of starting an unsigned app.
  try {
    execFileSync("codesign", ["--force", "--sign", "-", dst], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    fs.rmSync(dst, { recursive: true, force: true });
    console.error(`doppel: codesign failed on ${dst}: ${String(e.stderr || e.message).trim()}`);
    process.exit(1);
  }
  return exe;
}

const c = await loadConfig();
const argv = ownArgs(process.argv.slice(2));
const pos = argv.filter((a) => !a.startsWith("--"));
const [a = c.urls[0], b = c.urls[1], start = "/"] = pos;
const args = [APP, "--a", a, "--b", b, "--path", start, ...argv.filter((x) => x.startsWith("--"))];
if (c.theme) args.push("--theme", `${c.theme.param}=${c.theme.values.join(",")}`);
if (c.selftest) args.push("--selftest-file", c.selftest);

const LOGS = process.platform === "darwin" ? path.join(os.homedir(), "Library/Logs/Doppel") : path.join(os.tmpdir(), "doppel-logs");
fs.mkdirSync(LOGS, { recursive: true });
for (const f of fs.readdirSync(LOGS).filter((f) => /^mirror-.*\.log$/.test(f)).sort().slice(0, -29)) fs.rmSync(path.join(LOGS, f));
const logFile = path.join(LOGS, `mirror-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
args.push("--log", logFile);
console.log(`mirror: log ${logFile}`);

const child = spawn(electron, args, { stdio: ["ignore", "inherit", "pipe"] });
// Chromium logs GPU and network noise on stderr: all of it goes to the log,
// only the rest to the terminal.
child.stderr.on("data", (d) => {
  fs.appendFileSync(logFile, d);
  const s = String(d)
    .split("\n")
    .filter((l) => l && !/^\[\d+:\d+\/[\d.]+:(ERROR|WARNING|INFO|VERBOSE)/.test(l))
    .join("\n");
  if (s) process.stderr.write(s + "\n");
});
child.on("exit", (code, signal) => {
  fs.appendFileSync(logFile, `${new Date().toISOString()} doppel electron-exit ${JSON.stringify({ code, signal })}\n`);
  if (code || signal) console.error(`mirror: Electron ended (${signal || `code ${code}`}), see ${logFile}`);
  process.exit(code ?? (signal ? 1 : 0));
});
