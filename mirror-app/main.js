// One window: a toolbar on top, version A on the left, version B on the right.
// Input in A is replayed in B (sync.js); the toolbar sets both to a screen
// size (viewport.js), a theme or an address.
//
//   electron . [--a URL] [--b URL] [--path /] [--theme param=v1,v2]
//              [--selftest [--selftest-file project-checks.mjs]]
//
// Nothing here knows about a particular site: ../mirror.mjs passes what the
// project's doppel.config.mjs says (URLs, the theme switch, its checks).
import { app, BaseWindow, Menu, WebContentsView, ipcMain, screen } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mirror } from "./sync.js";
import { PRESETS, applyViewport, parseSize } from "./viewport.js";

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

app.whenReady().then(async () => {
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BaseWindow({
    ...workArea,
    title: "Doppel",
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
    let retry = null;
    v.webContents.on("did-fail-load", (_e, code, _desc, url, isMain) => {
      if (!isMain || code === -3 || retry) return; // -3: aborted by a newer load
      label = `${name}: waiting for its server...`;
      state();
      retry = setTimeout(() => {
        retry = null;
        if (!v.webContents.isDestroyed()) v.webContents.loadURL(url).catch(() => {});
      }, 1500);
    });
    v.webContents.on("did-finish-load", () => layout());
  }
  win.on("closed", () => app.quit());

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
  for (const side of ["a", "b"]) {
    const wc = pageOf[side].webContents;
    wc.on("devtools-closed", () => tools[side] && toggleTools(side, false));
    // Right-click > Inspect, as in Chrome.
    wc.on("context-menu", (_e, p) =>
      Menu.buildFromTemplate([
        {
          label: `Inspect (${side.toUpperCase()})`,
          click: () => {
            toggleTools(side, true);
            wc.inspectElement(p.x, p.y);
          },
        },
      ]).popup(),
    );
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
  ipcMain.on("mirror:ctl", (ev, cmd, val) => {
    if (ev.sender !== bar.webContents) return;
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
      const u = new URL(a.webContents.getURL());
      if (!THEMES) return;
      u.searchParams.set(THEMES.param, val);
      a.webContents.loadURL(u.href); // B follows (sync.js)
    } else if (cmd === "reload") both.forEach((wc) => wc.reload());
    else if (cmd === "back") both.forEach((wc) => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack());
    else if (cmd === "forward") both.forEach((wc) => wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward());
    else if (cmd === "go") {
      const p = String(val || "/").trim();
      a.webContents.loadURL(A + (p.startsWith("/") ? p : `/${p}`));
    }
  });

  await bar.webContents.loadFile(path.join(here, "toolbar.html"));
  layout();
  await Promise.all([a.webContents.loadURL(A + START), b.webContents.loadURL(B + START)]).catch((e) => console.error(`mirror: ${e.message}`));
  state();
  // B is never focused (you type in A), so it would not show focus rings or
  // :focus-visible; tell it it has focus. Only once it has a page: before
  // that the command never answers.
  try {
    b.webContents.debugger.attach("1.3");
    await b.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  } catch {}

  if (SELFTEST) {
    win.showInactive(); // a hidden window gets no input
    setTimeout(() => (console.log("selftest: timed out (are both servers up?)"), app.exit(2)), 180000);
    const { selftest } = await import("./selftest.js");
    const metrics = () => app.getAppMetrics().reduce((n, p) => n + p.memory.workingSetSize, 0);
    const ok = await selftest({ metrics, a: a.webContents, b: b.webContents, scale: () => scale, setPreset: (p) => ((preset = p), layout()), setCustom: (t) => ipcMain.emit("mirror:ctl", { sender: bar.webContents }, "custom", t), themes: THEMES, project: PROJECT_CHECKS, toggleTools, toggleFill: () => ipcMain.emit("mirror:ctl", { sender: bar.webContents }, "fill"), theme: (t) => ipcMain.emit("mirror:ctl", { sender: bar.webContents }, "theme", t) });
    app.exit(ok ? 0 : 1);
  } else console.log(`mirror: A ${A}  B ${B}  (drive the left pane)`);
});
