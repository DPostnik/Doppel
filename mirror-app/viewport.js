// Screen-size presets: every page in the list shows the same viewport,
// scaled down to fit the area it has. `null` is the area's own size.
export const PRESETS = {
  window: null,
  "4k": [3840, 2160],
  "2k": [2560, 1440],
  fullhd: [1920, 1080],
  laptop: [1440, 900],
  tablet: [768, 1024],
  phone: [390, 844],
};

// disableDeviceEmulation on a webContents that never had it crashes Electron
// (45, before the first page loads), so only undo what was done.
const emulated = new WeakSet();

/** Parses "1280x800", "1280 800" or "1280" (height from the pane) into a
 *  size, or returns null. */
export function parseSize(text) {
  const m = String(text).trim().match(/^(\d{2,5})(?:\s*[x×*, ]\s*(\d{2,5}))?$/i);
  return m ? [+m[1], m[2] ? +m[2] : null] : null;
}

/** Emulates `size` ([width, height], height null = the pane's) in every
 *  webContents shown in a `w` x `h` pane, scaled down to fit. With `fill` the
 *  width is kept and the height grows or shrinks to fill the pane, so a wide
 *  size in a half-screen pane does not leave the bottom empty. Returns the
 *  scale (1 = actual size) and a label for the toolbar. */
export function applyViewport(contents, size, w, h, fill) {
  if (!size) {
    for (const wc of contents) if (emulated.has(wc)) wc.disableDeviceEmulation(), emulated.delete(wc);
    return { scale: 1, label: `${w}x${h}, 100%` };
  }
  const [vw, preset] = size;
  let scale, vh;
  if (fill || !preset) {
    scale = Math.min(1, w / vw);
    vh = Math.floor(h / scale);
  } else {
    scale = Math.min(1, w / vw, h / preset);
    vh = preset;
  }
  for (const wc of contents) {
    emulated.add(wc);
    wc.enableDeviceEmulation({
      screenPosition: "desktop",
      screenSize: { width: vw, height: vh },
      viewPosition: { x: 0, y: 0 },
      viewSize: { width: vw, height: vh },
      deviceScaleFactor: 0,
      scale,
    });
  }
  return { scale, label: `${vw}x${vh}${vh !== preset ? " (fill)" : ""}, ${Math.round(scale * 100)}%` };
}
