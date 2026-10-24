// Preload of the left page (A): reports the user's real input to the main
// process, which replays it in B (sync.js). Runs in an isolated world, so the
// site's own scripts never see it. Moves are sent at most once a frame.
const { ipcRenderer } = require("electron");

if (window.top === window) {
  const send = (e) => ipcRenderer.send("mirror:input", e);
  // Modifiers ride on every event: a key released outside the page (in the
  // toolbar, say) never sends its keyup, and B would keep it held.
  const mods = (e) => ({ shift: e.shiftKey, control: e.ctrlKey, alt: e.altKey, meta: e.metaKey });
  let move = null;
  let scrolled = false;
  const flush = () => {
    if (move) send(move);
    move = null;
  };
  // Page scroll goes over as a position once a frame: replaying wheel events
  // would scroll B by its own amount and then snap it back.
  const flushScroll = () => {
    if (scrolled) send({ t: "scroll", x: scrollX, y: scrollY });
    scrolled = false;
  };
  // A wheel over an element that scrolls on its own (a menu, a table) is
  // replayed as a wheel; the page itself follows by position.
  const innerScroller = (el) => {
    for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (/auto|scroll/.test(cs.overflowY + cs.overflowX) && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)) return true;
    }
    return false;
  };
  const tick = () => {
    flush();
    flushScroll();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const opt = { capture: true, passive: true };
  addEventListener("mousemove", (e) => { if (e.isTrusted) move = { t: "move", x: e.clientX, y: e.clientY, m: mods(e) }; }, opt);
  addEventListener("mousedown", (e) => { if (e.isTrusted) { flush(); send({ t: "down", x: e.clientX, y: e.clientY, b: e.button, n: e.detail, m: mods(e) }); } }, opt);
  addEventListener("mouseup", (e) => { if (e.isTrusted) { flush(); send({ t: "up", x: e.clientX, y: e.clientY, b: e.button, n: e.detail, m: mods(e) }); } }, opt);
  addEventListener("wheel", (e) => { if (e.isTrusted && innerScroller(e.target)) { flush(); send({ t: "wheel", x: e.clientX, y: e.clientY, dx: e.deltaX, dy: e.deltaY, m: mods(e) }); } }, opt);
  addEventListener("keydown", (e) => { if (e.isTrusted) send({ t: "kd", key: e.key, m: mods(e) }); }, opt);
  addEventListener("keyup", (e) => { if (e.isTrusted) send({ t: "ku", key: e.key, m: mods(e) }); }, opt);
  addEventListener("scroll", (e) => { if (e.target === document) scrolled = true; }, opt);
}
