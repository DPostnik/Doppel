// One window: a toolbar on top, version A on the left, version B on the right.
// Input in A is replayed in B (sync.js); the toolbar sets both to a screen
// size (viewport.js), a theme or an address.
//
//   electron . [--a URL] [--b URL] [--path /] [--theme param=v1,v2]
//              [--selftest [--selftest-file project-checks.mjs]] [--log file]
//
// Nothing here knows about a particular site: ../mirror.mjs passes what the
// project's doppel.config.mjs says (URLs, the theme switch, its checks).
import { app, BaseWindow, Menu, WebContentsView, ipcMain, screen } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mirror } from "./sync.js";
import { PRESETS, applyViewport, parseSize } from "./viewport.js";
import { startLog, watchApp, watchPane } from "./watch.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const A = arg("a", "http://localhost:3141").replace(/\/$/, "");
const B = arg("b", "http://localhost:3142").replace(/\/$/, "");
const START = arg("path", "/");
// "theme=dark,light": the query parameter and its values, one button each.
const THEMES = (() => {
  const m = String(arg("theme", "")).match(/^([^=]+)=(.+)$/);
  return m ? { param: m[1], values: m[2].split(",") } : null;
})();
const SELFTEST = process.argv.includes("--selftest");
const PROJECT_CHECKS = arg("selftest-file", null);
const log = startLog(arg("log", null), { selftest: SELFTEST });

const BAR = 40; // toolbar height
const GAP = 6; // the divider between the panes
const TOOLS = 0.42; // share of the pane height DevTools take when open

const pathOf = (u) => {
  try {
    const x = new URL(u);
    return x.pathname + x.search + x.hash;
  } catch {
    return "";
  }
};

// A pane that is never focused (B: you type in A; both in a selftest, whose
// window is shown inactive) shows no focus rings or :focus-visible; tell it it
// has focus. The command does not answer while the pane has no page, so it is
// raced against a timeout; false means try again on the next page.
const enableFocus = async (wc) => {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
  } catch {
    return false;
  }
  const command = wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }).then(() => true, () => false);
  return Promise.race([command, new Promise((r) => setTimeout(r, 3000, false))]);
};

// icon.png is rendered from icon.svg. The app runs unpackaged, so macOS would
// show Electron's own icon in the Dock without this.
const ICON = path.join(here, "icon.png");

app.whenReady().then(async () => {
  watchApp(log);
  app.dock?.setIcon(ICON);
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BaseWindow({
    ...workArea,
    title: "Doppel",
    icon: ICON, // Linux and Windows; macOS takes the Dock icon above
    backgroundColor: "#3a3a3a", // shows through as the divider
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 12, y: 13 },
    show: !SELFTEST,
  });
  const view = (preload) =>
    new WebContentsView({
      webPreferences: { preload, sandbox: true, contextIsolation: true, spellcheck: false },
    });
  const bar = view(path.join(here, "toolbar.cjs"));
  const a = view(path.join(here, "record.cjs"));
  const b = view();
  for (const v of [bar, a, b]) win.contentView.addChildView(v);
  for (const [v, name] of [[bar, "toolbar"], [a, "A"], [b, "B"]]) watchPane(log, v.webContents, name);

  let preset = "window"; // a PRESETS key or "custom"
  let custom = null; // [width, height | null] typed in the toolbar
  let fill = true;
  let scale = 1;
  let label = "";
  const state = () =>
    bar.webContents.send("mirror:state", {
      presets: Object.entries(PRESETS),
      themes: THEMES?.values ?? [],
      preset,
      fill,
      tools: { a: !!tools.a, b: !!tools.b },
      label: `${label} · A ${A.replace(/^https?:\/\//, "")} · B ${B.replace(/^https?:\/\//, "")}`,
      path: pathOf(a.webContents.getURL()),
    });
  const layout = () => {
    const { width, height } = win.getContentBounds();
    const w = Math.floor((width - GAP) / 2);
    // With DevTools open under either pane, both panes shrink alike so A and
    // B keep the same viewport.
    const th = tools.a || tools.b ? Math.round((height - BAR) * TOOLS) : 0;
    const h = height - BAR - th;
    bar.setBounds({ x: 0, y: 0, width, height: BAR });
    a.setBounds({ x: 0, y: BAR, width: w, height: h });
    b.setBounds({ x: w + GAP, y: BAR, width: w, height: h });
    tools.a?.setBounds({ x: 0, y: BAR + h + 1, width: w, height: th - 1 });
    tools.b?.setBounds({ x: w + GAP, y: BAR + h + 1, width: w, height: th - 1 });
    const size = preset === "custom" ? custom : PRESETS[preset];
    ({ scale, label } = applyViewport([a.webContents, b.webContents], size, w, h, fill));
    state();
  };
  win.on("resize", layout);

  // A pane whose server is down (being rebuilt by `doppel up --only b`, say)
  // retries until it answers, so the window never needs a restart.
  for (const [v, name] of [[a, "A"], [b, "B"]]) {
    const wc = v.webContents;
    let retry = null;
    let failed = null; // the latest address that failed: retry that one, not an older one
    wc.on("did-fail-load", (_e, code, _desc, url, isMain) => {
      if (!isMain || code === -3) return; // -3: aborted by a newer load
      failed = url;
      label = `${name}: waiting for its server...`;
      state();
      retry ??= setTimeout(() => {
        retry = null;
        if (wc.isDestroyed()) return;
        // Gone elsewhere meanwhile (an address typed, B following A): leave it.
        const cur = wc.getURL();
        if (cur && cur !== failed && !cur.startsWith("chrome-error:")) return log("retry-skipped", { pane: name, failed, cur });
        wc.loadURL(failed).catch(() => {});
      }, 1500);
    });
    wc.on("did-finish-load", () => layout());
  }
  // B's focus, once it has a page (it may have none for a while: its server
  // down at the start).
  let focusDone = false;
  b.webContents.on("did-finish-load", async () => {
    if (focusDone) return;
    focusDone = true;
    if (!(await enableFocus(b.webContents))) (focusDone = false), log("focus-emulation-timeout", { pane: "B", url: b.webContents.getURL() });
  });
  win.on("closed", () => (log("window-closed"), app.quit()));

  mirror({ source: a.webContents, target: b.webContents, originB: B, scale: () => scale });
  a.webContents.on("did-navigate", state);
  a.webContents.on("did-navigate-in-page", state);

  // ---- DevTools, docked under a pane inside this window ----
  // A DevTools front end needs a fresh webContents each time it opens.
  const tools = { a: null, b: null };
  const pageOf = { a, b };
  const toggleTools = (side, open = !tools[side]) => {
    const wc = pageOf[side].webContents;
    if (!open && tools[side]) {
      const v = tools[side];
      tools[side] = null;
      wc.closeDevTools();
      win.contentView.removeChildView(v);
      v.webContents.close();
    } else if (open && !tools[side]) {
      const v = new WebContentsView();
      tools[side] = v;
      win.contentView.addChildView(v);
      wc.setDevToolsWebContents(v.webContents);
      wc.openDevTools({ mode: "detach", activate: false });
    }
    layout();
  };
  const menus = { a: 0, b: 0 }; // context menus asked for, per pane (selftest)
  for (const side of ["a", "b"]) {
    const wc = pageOf[side].webContents;
    wc.on("devtools-closed", () => tools[side] && toggleTools(side, false));
    // Right-click > Inspect, as in Chrome. A right click in A is not replayed
    // in B (record.cjs), so this opens once; B keeps it for a right click of
    // its own. A selftest only counts: an open menu would hold the run.
    wc.on("context-menu", (_e, p) => {
      menus[side]++;
      if (SELFTEST) return;
      Menu.buildFromTemplate([
        {
          label: `Inspect (${side.toUpperCase()})`,
          click: () => {
            toggleTools(side, true);
            wc.inspectElement(p.x, p.y);
          },
        },
      ]).popup();
    });
  }
  // Cmd+Opt+I / F12 in A opens A's DevTools and is not replayed in B.
  a.webContents.on("before-input-event", (e, i) => {
    if (i.type === "keyDown" && (i.key === "F12" || (i.meta && i.alt && i.code === "KeyI"))) {
      e.preventDefault();
      toggleTools("a");
    }
  });

  const both = [a.webContents, b.webContents];
  // Cmd-click or target=_blank would open bare Electron windows; stay here.
  for (const wc of both) wc.setWindowOpenHandler(() => ({ action: "deny" }));
  // A load that fails here (a server down) is handled by the retry above.
  const load = (wc, url) => wc.loadURL(url).catch(() => {});
  const control = (cmd, val) => {
    if (cmd === "size" && val in PRESETS) {
      preset = val;
      layout();
    } else if (cmd === "custom") {
      const size = parseSize(val);
      if (size) (custom = size), (preset = "custom");
      layout();
    } else if (cmd === "devtools" && (val === "a" || val === "b")) toggleTools(val);
    else if (cmd === "fill") {
      fill = !fill;
      layout();
    } else if (cmd === "theme") {
      if (!THEMES) return;
      // An empty pane or an error page has no address of A's: theme the start page.
      const cur = a.webContents.getURL();
      const u = new URL(cur.startsWith(A + "/") ? cur : A + START);
      u.searchParams.set(THEMES.param, val);
      load(a.webContents, u.href); // B follows (sync.js)
    } else if (cmd === "reload") both.forEach((wc) => wc.reload());
    else if (cmd === "back") both.forEach((wc) => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack());
    else if (cmd === "forward") both.forEach((wc) => wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward());
    else if (cmd === "go") {
      // A whole address pasted in (from B, from a browser) keeps only its path.
      let p = String(val || "/").trim();
      if (/^https?:/i.test(p)) p = pathOf(p) || "/";
      load(a.webContents, A + (p.startsWith("/") ? p : `/${p}`));
    }
  };
  ipcMain.on("mirror:ctl", (ev, cmd, val) => {
    if (ev.sender !== bar.webContents) return;
    try {
      control(cmd, val);
    } catch (e) {
      log("ctl-error", { cmd, message: e.message });
    }
  });

  await bar.webContents.loadFile(path.join(here, "toolbar.html"));
  layout();
  await Promise.all([a.webContents.loadURL(A + START), b.webContents.loadURL(B + START)]).catch((e) => console.error(`mirror: ${e.message}`));
  state();

  if (SELFTEST) {
    win.showInactive(); // a hidden window gets no input
    const { selftest } = await import("./selftest.js");
    const metrics = () => app.getAppMetrics().reduce((n, p) => n + p.memory.workingSetSize, 0);
    const ok = await selftest({ metrics, menus, enableFocus, a: a.webContents, b: b.webContents, scale: () => scale, setPreset: (p) => ((preset = p), layout()), setCustom: (t) => ipcMain.emit("mirror:ctl", { sender: bar.webContents }, "custom", t), themes: THEMES, project: PROJECT_CHECKS, toggleTools, toggleFill: () => ipcMain.emit("mirror:ctl", { sender: bar.webContents }, "fill"), theme: (t) => ipcMain.emit("mirror:ctl", { sender: bar.webContents }, "theme", t), go: (p) => ipcMain.emit("mirror:ctl", { sender: bar.webContents }, "go", p) });
    app.exit(ok ? 0 : 1);
  } else console.log(`mirror: A ${A}  B ${B}  (drive the left pane)`);
});
