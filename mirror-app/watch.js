// Crash log of the mirror window: one file per run, so a crash can be traced
// after the fact. ../mirror.mjs names the file (--log) and copies Chromium's
// full stderr into it; this module adds what the main process sees: dead or
// hung panes, dead helper processes (GPU, network), uncaught errors, page
// console errors, memory once a minute, and how the app ended.
//
//   const log = startLog(file);           // before app is ready (crash dumps)
//   watchPane(log, webContents, "A");     // for each pane
//   watchApp(log);                        // once the app is ready
import { app, crashReporter } from "electron";
import fs from "node:fs";
import path from "node:path";

export function startLog(file) {
  const line = (kind, data = {}) => {
    const s = `${new Date().toISOString()} doppel ${kind} ${JSON.stringify(data)}\n`;
    if (file) fs.appendFileSync(file, s);
    else process.stderr.write(s);
  };
  // Native crashes leave a minidump next to the logs (nothing is uploaded).
  if (file) app.setPath("crashDumps", path.join(path.dirname(file), "crashdumps"));
  crashReporter.start({ uploadToServer: false });
  process.on("uncaughtException", (e) => line("uncaught-exception", { message: e.message, stack: e.stack }));
  process.on("unhandledRejection", (e) => line("unhandled-rejection", { message: String(e?.message ?? e), stack: e?.stack }));
  line("start", { electron: process.versions.electron, chrome: process.versions.chrome, argv: process.argv.slice(2) });
  return line;
}

export function watchPane(log, wc, name) {
  wc.on("render-process-gone", (_e, d) => log("pane-gone", { pane: name, url: wc.getURL(), reason: d.reason, exitCode: d.exitCode }));
  wc.on("unresponsive", () => log("pane-unresponsive", { pane: name, url: wc.getURL() }));
  wc.on("responsive", () => log("pane-responsive", { pane: name }));
  wc.on("preload-error", (_e, file, err) => log("preload-error", { pane: name, file, message: err.message }));
  wc.on("console-message", (e) => {
    if (e.level === "error") log("console-error", { pane: name, message: e.message, source: `${e.sourceId}:${e.lineNumber}` });
  });
}

export function watchApp(log) {
  app.on("child-process-gone", (_e, d) => log("process-gone", { type: d.type, name: d.name, reason: d.reason, exitCode: d.exitCode }));
  // Memory of every process, in MB: a pane that grows run after run shows here.
  const memory = () => {
    const procs = app.getAppMetrics().map((p) => ({ type: p.type, pid: p.pid, mb: Math.round(p.memory.workingSetSize / 1024) }));
    log("memory", { totalMb: procs.reduce((n, p) => n + p.mb, 0), procs });
  };
  memory();
  setInterval(memory, 60000).unref();
  app.on("before-quit", () => log("before-quit"));
  app.on("will-quit", () => log("will-quit"));
  process.on("exit", (code) => log("exit", { code }));
}
