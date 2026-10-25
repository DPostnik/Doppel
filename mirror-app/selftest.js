// `--selftest`: drives the left pane with real input and checks that the
// right pane followed. The checks here need no knowledge of the site (sizes,
// scroll, DevTools, theme); a project adds its own (clicks on its buttons,
// menus, forms) in the file the config's `selftest` names, which gets the
// helpers below as `t`. Prints one line per check; true when all pass.
import { pathToFileURL } from "node:url";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function selftest({ a, b, scale, setPreset, setCustom, toggleFill, toggleTools, theme, themes, project, metrics, menus, enableFocus }) {
  const js = (wc, code) => wc.executeJavaScript(code);
  const both = async (code) => [await js(a, code), await js(b, code)];
  const center = async (sel) => {
    const r = await js(a, `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
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
  /** Passes when A and B agree and, if `want` is given, equal it. */
  const check = (name, [va, vb], want) => {
    const ok = JSON.stringify(va) === JSON.stringify(vb) && (want === undefined || JSON.stringify(va) === JSON.stringify(want));
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

  console.log(`memory: ${Math.round(metrics() / 1024)} MB in all processes`);
  console.log(fails ? `${fails} check(s) failed` : "all checks passed");
  return !fails;
}
