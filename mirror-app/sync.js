// Replays input recorded in one page (record.cjs) in another, and keeps the
// second page on the same address. No Electron windows here: give it two
// webContents and a function returning the current scale.
//
//   const stop = mirror({ source: a.webContents, target: b.webContents, originB, scale: () => k });
//
// Points arrive in A's CSS pixels; B takes view pixels, so they are times the
// scale both pages are shown at (viewport.js).
import { ipcMain } from "electron";

const BUTTON = ["left", "middle", "right"];
// DOM key names that Electron's sendInputEvent spells differently.
const KEY = { ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", " ": "Space", Meta: "Meta", Control: "Control", Alt: "Alt", Shift: "Shift" };
const modifiers = (m) => (m ? Object.keys(m).filter((k) => m[k]) : []);

export function mirror({ source, target, originB, scale }) {
  // Only the latest move matters: a backlog of moves is dropped, not replayed.
  let pendingMove = null;
  let raf = null;
  const flushMove = () => {
    raf = null;
    if (!pendingMove || target.isDestroyed()) return;
    const e = pendingMove;
    pendingMove = null;
    target.sendInputEvent({ type: "mouseMove", x: e.x * scale(), y: e.y * scale(), modifiers: modifiers(e.m) });
  };

  // Page scroll: one position in flight at a time, the latest wins.
  let scrollWant = null;
  let scrolling = false;
  const scrollTo = async (x, y) => {
    scrollWant = [+x, +y];
    if (scrolling) return;
    scrolling = true;
    while (scrollWant && !target.isDestroyed()) {
      const [sx, sy] = scrollWant;
      scrollWant = null;
      await target.executeJavaScript(`scrollTo({ left: ${sx}, top: ${sy}, behavior: "instant" })`).catch(() => {});
    }
    scrolling = false;
  };

  const onInput = (ev, e) => {
    if (ev.sender !== source || target.isDestroyed()) return;
    const k = scale();
    const at = { x: Math.round(e.x * k), y: Math.round(e.y * k), modifiers: modifiers(e.m) };
    switch (e.t) {
      case "move":
        pendingMove = e;
        raf ??= setTimeout(flushMove, 8);
        break;
      case "down":
      case "up":
        flushMove();
        target.sendInputEvent({ type: e.t === "down" ? "mouseDown" : "mouseUp", ...at, button: BUTTON[e.b] || "left", clickCount: e.n || 1 });
        break;
      case "wheel":
        // Only wheels over an inner scroller come here (record.cjs). Electron's
        // deltas point the other way and are in view pixels.
        target.sendInputEvent({ type: "mouseWheel", ...at, deltaX: -e.dx * k, deltaY: -e.dy * k });
        break;
      case "scroll":
        scrollTo(e.x, e.y);
        break;
      case "kd":
      case "ku": {
        const keyCode = KEY[e.key] ?? e.key;
        target.sendInputEvent({ type: e.t === "kd" ? "keyDown" : "keyUp", keyCode, modifiers: modifiers(e.m) });
        // A printable key also types its character (unless it is a shortcut).
        if (e.t === "kd" && e.key.length === 1 && !e.m?.meta && !e.m?.control) target.sendInputEvent({ type: "char", keyCode: e.key, modifiers: modifiers(e.m) });
        break;
      }
    }
  };
  ipcMain.on("mirror:input", onInput);

  // Address sync: a click navigates both on its own; a typed address, Back or
  // a reload in A only A, so B follows after a moment if it is elsewhere.
  const path = (u) => {
    try {
      const x = new URL(u);
      return x.pathname + x.search + x.hash;
    } catch {
      return "";
    }
  };
  let navTimer;
  const onNav = () => {
    clearTimeout(navTimer);
    navTimer = setTimeout(() => {
      if (target.isDestroyed() || source.isDestroyed()) return;
      const want = path(source.getURL());
      if (want && path(target.getURL()) !== want) target.loadURL(originB + want);
    }, 700);
  };
  source.on("did-navigate", onNav);
  source.on("did-navigate-in-page", onNav);

  return () => {
    ipcMain.off("mirror:input", onInput);
    source.off("did-navigate", onNav);
    source.off("did-navigate-in-page", onNav);
    clearTimeout(navTimer);
  };
}
