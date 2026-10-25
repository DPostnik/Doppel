// `--selftest`: drives the left pane with real input and checks that the
// right pane followed. The checks here need no knowledge of the site (sizes,
// scroll, DevTools, theme); a project adds its own (clicks on its buttons,
// menus, forms) in the file the config's `selftest` names, which gets the
// helpers below as `t`. Prints one line per check; true when all pass.
import { app } from "electron";
import { pathToFileURL } from "node:url";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (code) => (code.length > 100 ? `${code.slice(0, 97)}...` : code).replace(/\s+/g, " ");

export async function selftest({ a, b, scale, setPreset, setCustom, toggleFill, toggleTools, theme, themes, project, metrics, menus, enableFocus, go }) {
  // Electron reports any error in the page as "Script failed to execute", so
  // the code runs as an expression that hands its error back; a failure then
  // names the pane, the error and the code.
  const js = async (wc, code) => {
    const side = wc === a ? "A" : wc === b ? "B" : "a page";
    const r = await wc.executeJavaScript(`(async () => { try { return { v: await (${code}\n) }; } catch (e) { return { e: String(e) }; } })()`).catch(() => null);
    if (r && "e" in r) throw new Error(`selftest: ${r.e} in ${side}, running ${short(code)}`);
    if (r) return r.v;
    // Not an expression (statements): run it as it is.
    return wc.executeJavaScript(code).catch(() => {
      throw new Error(`selftest: script failed in ${side}: ${short(code)}`);
    });
  };
  const both = async (code) => [await js(a, code), await js(b, code)];
  const center = async (sel) => {
    const r = await js(a, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    if (!r) throw new Error(`selftest: no element for ${sel} in A`);
    return r.map((v) => Math.round(v * scale()));
  };
  const click = async (sel) => {
    const [x, y] = await center(sel);
    a.sendInputEvent({ type: "mouseMove", x, y });
    await wait(50);
    a.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    a.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  };
  const key = (keyCode, char) => {
    a.sendInputEvent({ type: "keyDown", keyCode });
    if (char) a.sendInputEvent({ type: "char", keyCode });
    a.sendInputEvent({ type: "keyUp", keyCode });
  };
  let fails = 0;
  // A run that hangs (a page that never answers) says where it got to.
  let last = "none";
  const timer = setTimeout(() => {
    console.log(`selftest: timed out after 180 s; last check done: ${last} (are both servers up?)`);
    app.exit(2);
  }, 180000);
  /** Passes when A and B agree and, if `want` is given, equal it. */
  const check = (name, [va, vb], want) => {
    const ok = JSON.stringify(va) === JSON.stringify(vb) && (want === undefined || JSON.stringify(va) === JSON.stringify(want));
    last = name;
    if (!ok) fails++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: A ${JSON.stringify(va)}  B ${JSON.stringify(vb)}`);
  };
  const t = { a, b, js, both, center, click, key, check, wait, scale, setPreset, setCustom, toggleFill, toggleTools, theme, themes };

  // The window is shown inactive, so A has no focus either; pretend it has,
  // as when you use it.
  await enableFocus(a);
  await wait(800);

  for (const p of ["4k", "phone", "fullhd"]) {
    setPreset(p);
    await wait(300);
    check(`size ${p}`, await both("innerWidth"));
  }
  setCustom("1280x700");
  await wait(300);
  check("custom size 1280 wide", await both("innerWidth"), 1280);
  toggleFill();
  await wait(300);
  check("fill off keeps its height", await both("innerHeight"), 700);
  toggleFill();
  setPreset("fullhd");
  await wait(300);

  // Page scroll: B must track A while the wheel turns, not overshoot and
  // snap back.
  let drift = 0;
  for (let i = 0; i < 30; i++) {
    a.sendInputEvent({ type: "mouseWheel", x: 300, y: 300, deltaX: 0, deltaY: -40 });
    await wait(16);
    if (i % 3 === 2) {
      const [ya, yb] = await both("Math.round(scrollY)");
      drift = Math.max(drift, Math.abs(ya - yb));
    }
  }
  await wait(900);
  const [ea, eb] = await both("Math.round(scrollY)");
  check(`wheel: B tracks A (max gap ${drift}px, end ${ea})`, [ea > 0 && drift <= 60 && ea === eb, true]);
  await js(a, "scrollTo(0, 0)");
  await wait(600);

  // DevTools dock under the panes; both panes shrink alike.
  const [h0] = await both("innerHeight");
  toggleTools("b");
  await wait(1500);
  const [h1, h1b] = await both("innerHeight");
  // (isDevToolsOpened stays false for DevTools hosted in our own view.)
  const front = b.devToolsWebContents;
  check("DevTools B open, panes shrink alike", [!!front?.getURL().startsWith("devtools://") && h1 < h0 && h1 === h1b, true]);
  toggleTools("b");
  await wait(500);
  check("DevTools B closed, panes back", [(await js(a, "innerHeight")) === h0, true]);

  // A right click in A opens one context menu (A's), not one per pane.
  const m0 = { ...menus };
  a.sendInputEvent({ type: "mouseMove", x: 300, y: 300 });
  a.sendInputEvent({ type: "mouseDown", x: 300, y: 300, button: "right", clickCount: 1 });
  a.sendInputEvent({ type: "mouseUp", x: 300, y: 300, button: "right", clickCount: 1 });
  await wait(600);
  check("right click: one menu, in A", [[menus.a - m0.a, menus.b - m0.b], [1, 0]]);

  // A click on a link navigates B by the replayed click alone, once: the
  // address sync must not load the page again on top. Any visible link to
  // another page of the site will do.
  const home = a.getURL();
  const link = await js(a, `(() => {
    for (const l of document.querySelectorAll("a[href]")) {
      const u = new URL(l.href, location.href);
      if (u.origin !== location.origin || u.pathname === location.pathname || l.target || l.hasAttribute("download") || l.hasAttribute("aria-haspopup")) continue;
      const r = l.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && document.elementFromPoint(x, y)?.closest("a") === l) return [x, y, u.pathname];
    }
    return null;
  })()`);
  if (link) {
    // Navigations started, not finished: a load aborted by a second one
    // never finishes.
    let navs = 0;
    const count = (d) => d.isMainFrame && navs++;
    b.on("did-start-navigation", count);
    const [x, y] = [link[0], link[1]].map((v) => Math.round(v * scale()));
    a.sendInputEvent({ type: "mouseMove", x, y });
    await wait(50);
    a.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    a.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    await wait(3000);
    b.off("did-start-navigation", count);
    const [pa, pb] = await both("location.pathname");
    check(`click link ${link[2]}: B navigates once`, [[pa, pb, navs], [link[2], link[2], 1]]);
    a.loadURL(home).catch(() => {}); // B follows
    await wait(2000);
  } else console.log("skip click link: no link to another page in view");

  // The mouse leaving A takes B's hover away as well.
  const hover = () => both(`!!document.querySelector("body:hover")`);
  a.sendInputEvent({ type: "mouseMove", x: 300, y: 300 });
  await wait(300);
  const over = await hover();
  a.sendInputEvent({ type: "mouseLeave", x: -1, y: -1 });
  await wait(300);
  check("mouse leaves A: B drops its hover", [[...over, ...(await hover())], [true, true, false, false]]);

  // A whole address typed in the toolbar keeps only its path, on A's server.
  go("http://elsewhere.invalid:9/?doppel=1#top");
  await wait(2000);
  check("full URL typed: its path only", await both("location.pathname + location.search + location.hash"), "/?doppel=1#top");
  check("full URL typed: A's server", [new URL(a.getURL()).origin, new URL(home).origin]);
  a.loadURL(home).catch(() => {});
  await wait(2000);

  if (themes) {
    theme(themes.values[1]);
    await wait(3000);
    check(`theme ${themes.values[1]}`, await both(`new URLSearchParams(location.search).get(${JSON.stringify(themes.param)})`), themes.values[1]);
  }

  if (project) {
    console.log(`-- project checks (${project})`);
    const run = (await import(pathToFileURL(project).href)).default;
    if (themes) {
      theme(themes.values[0]);
      await wait(2500);
    }
    setPreset("fullhd");
    await wait(300);
    // A check that throws (a selector the page no longer has) fails the run
    // now, not after the three-minute timeout.
    try {
      await run(t);
    } catch (e) {
      fails++;
      console.log(`FAIL project checks stopped: ${e.message.split("\n")[0]}`);
    }
  }

  clearTimeout(timer);
  console.log(`memory: ${Math.round(metrics() / 1024)} MB in all processes`);
  console.log(fails ? `${fails} check(s) failed` : "all checks passed");
  return !fails;
}
