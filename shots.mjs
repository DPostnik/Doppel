#!/usr/bin/env node
/**
 * Screenshot diff of two versions at every screen size in the config.
 *
 *   doppel shots [urlA] [urlB] [--all-themes] [--pages /,/about]
 *   defaults: the config's two ports, its first theme, its pages
 *
 * Each page is shot whole by scrolling one screen at a time at the real window
 * size and stitching (a tall "full page" window would change 100vh and re-run
 * any width measuring). With reducedMotion on, entrance animations are already
 * finished.
 *
 * Writes .doppel/<date-time>/index.html in the project: every page and size
 * with the share of differing pixels, and for each one that differs A, B and a
 * diff image (red = changed). Identical pairs keep no images.
 */
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { loadConfig, ownArgs } from "./config.mjs";
import { assertUp, withBrowser } from "./browser.mjs";

const c = await loadConfig();
const argv = ownArgs(process.argv.slice(2));
const flag = (n) => argv.includes(n);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const pos = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--pages");
const A = pos[0] || c.urls[0];
const B = pos[1] || c.urls[1];
const ROOT = c.root;

const PAGES = opt("--pages") ? opt("--pages").split(",") : c.pages;
const SIZES = c.sizes;
// No theme switch: one pass with no parameter.
const THEMES = !c.theme ? [null] : flag("--all-themes") ? c.theme.values : [c.theme.values[0]];
// One 4k image is w * h * 4 bytes: 300 MB at 20000 rows. Longer pages are cut
// and the report says so.
const MAX_H = 20000;

await assertUp({ A, B });

// Local time to the second; a second run within the same second gets -2, -3.
const d = new Date();
const two = (n) => String(n).padStart(2, "0");
const day = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
let stamp = day;
for (let i = 2; fs.existsSync(path.join(c.out, stamp)); i++) stamp = `${day}-${i}`;
const OUT = path.join(c.out, stamp);
fs.mkdirSync(OUT, { recursive: true });

async function shoot(browser, base, route, w, h, theme) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: w, height: h });
  if (c.reducedMotion) await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  const url = theme ? base + route + (route.includes("?") ? "&" : "?") + `${c.theme.param}=${theme}` : base + route;
  await page.goto(url, { waitUntil: "load", timeout: 120000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    const H = document.documentElement.scrollHeight;
    for (let y = 0; y < H; y += innerHeight / 2) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
    scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 1200));
  });
  const full = await page.evaluate(() => document.documentElement.scrollHeight);
  const total = Math.min(full, MAX_H);
  const img = new PNG({ width: w, height: total });
  img.full = full;
  for (let y = 0; y < total; y += h) {
    const at = await page.evaluate(async (y) => { scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); return scrollY; }, y);
    const shot = PNG.sync.read(Buffer.from(await page.screenshot({ type: "png" })));
    // The last screen cannot scroll past the end; copy only the rows not taken yet.
    const from = y - at;
    const rows = Math.min(h - from, total - y);
    for (let r = 0; r < rows; r++) shot.data.copy(img.data, (y + r) * w * 4, (from + r) * w * 4, (from + r + 1) * w * 4);
  }
  await ctx.close();
  return img;
}

function compare(a, b) {
  const w = a.width;
  const h = Math.max(a.height, b.height);
  const pad = (p) => {
    if (p.height === h) return p;
    const q = new PNG({ width: w, height: h });
    q.data.fill(0);
    for (let i = 3; i < q.data.length; i += 4) q.data[i] = 255;
    p.data.copy(q.data, 0, 0, p.data.length);
    return q;
  };
  const pa = pad(a), pb = pad(b);
  const opts = { threshold: 0.1, alpha: 0.25 };
  // Count first with no output image (pixelmatch takes null); most pairs are
  // identical and then never need the third w * h * 4 buffer.
  const n = pixelmatch(pa.data, pb.data, null, w, h, opts);
  let diff = null;
  if (n || a.height !== b.height) {
    diff = new PNG({ width: w, height: h });
    pixelmatch(pa.data, pb.data, diff.data, w, h, opts);
  }
  return { n, diff, share: n / (w * h) };
}

const jobs = [];
for (const route of PAGES) for (const [label, w, h] of SIZES) for (const theme of THEMES) jobs.push({ route, label, w, h, theme });
const results = [];
let next = 0;
// Weighted semaphore, first come first served: three small jobs at a time, but
// a job 2560 px wide or more takes the whole budget, so 4k and 2k run alone.
// Later jobs do not jump ahead of a waiting big one.
let free = 3;
const queue = [];
const grant = () => { while (queue.length && queue[0].n <= free) { const q = queue.shift(); free -= q.n; q.go(); } };
const acquire = (n) => new Promise((go) => { queue.push({ n, go }); grant(); });
const release = (n) => { free += n; grant(); };
await withBrowser((browser) => Promise.all(
  Array.from({ length: 3 }, async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      const name = `${j.label}${j.theme ? "-" + j.theme : ""}${j.route === "/" ? "-home" : j.route.replace(/[/?=&]+/g, "-")}`;
      const weight = j.w >= 2560 ? 3 : 1;
      await acquire(weight);
      try {
        let [a, b] = await Promise.all([shoot(browser, A, j.route, j.w, j.h, j.theme), shoot(browser, B, j.route, j.w, j.h, j.theme)]);
        let { n, diff, share } = compare(a, b);
        const capped = a.full > MAX_H || b.full > MAX_H ? `height capped at ${MAX_H}, page ${a.full}${a.full !== b.full ? ` vs ${b.full}` : ""}` : "";
        const r = { ...j, name, ha: a.height, hb: b.height, n, share, capped };
        const differ = n || a.height !== b.height;
        // Drop each image as soon as it is written, so the next PNG encode does
        // not stack on top of all three.
        if (differ) {
          fs.writeFileSync(path.join(OUT, name + "-a.png"), PNG.sync.write(a));
          a = null;
          fs.writeFileSync(path.join(OUT, name + "-b.png"), PNG.sync.write(b));
          b = null;
          fs.writeFileSync(path.join(OUT, name + "-diff.png"), PNG.sync.write(diff));
        }
        a = b = diff = null;
        results.push(r);
        console.log(`${differ ? "DIFF" : "same"}  ${name}  ${n} px${r.ha !== r.hb ? `, height ${r.ha} vs ${r.hb}` : ""}${capped ? `, ${capped}` : ""}`);
      } catch (e) {
        results.push({ ...j, name, error: e.message });
        console.log(`FAIL  ${name}  ${e.message}`);
      } finally {
        release(weight);
      }
    }
  }),
));

const order = Object.fromEntries(SIZES.map(([label], i) => [label, i]));
results.sort((x, y) => (y.n || 0) - (x.n || 0) || PAGES.indexOf(x.route) - PAGES.indexOf(y.route) || order[x.label] - order[y.label]);
const changed = results.filter((r) => r.n || r.ha !== r.hb || r.error);
const row = (r) => {
  const pct = r.error ? "error" : (r.share * 100).toFixed(3) + "%";
  const hgt = (r.ha === r.hb ? r.ha : `<b>${r.ha} vs ${r.hb}</b>`) + (r.capped ? `<br>${r.capped}` : "");
  const imgs = r.n || r.ha !== r.hb
    ? `<div class="imgs">${["a", "b", "diff"].map((k) => `<a href="${r.name}-${k}.png"><img loading="lazy" src="${r.name}-${k}.png"><span>${k === "a" ? "A" : k === "b" ? "B" : "diff"}</span></a>`).join("")}</div>`
    : "";
  return `<tr><td>${r.route}</td><td>${r.label}</td><td>${r.theme ?? ""}</td><td>${hgt}</td><td>${r.error || pct}</td></tr>${imgs ? `<tr><td colspan="5">${imgs}</td></tr>` : ""}`;
};
fs.writeFileSync(
  path.join(OUT, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>doppel ${stamp}</title>
<style>body{font:14px system-ui;margin:24px;background:#111;color:#ddd}table{border-collapse:collapse;width:100%}td{padding:4px 8px;border-bottom:1px solid #333;vertical-align:top}
.imgs{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.imgs a{color:#aaa;text-decoration:none}.imgs img{width:100%;max-height:600px;object-fit:contain;object-position:top;background:#000;display:block}b{color:#f66}</style>
<h1>A ${A} vs B ${B}</h1><p>${changed.length} of ${results.length} differ. Red in the diff marks changed pixels.</p>
<table><tr><th>page</th><th>size</th><th>theme</th><th>height</th><th>changed</th></tr>${changed.map(row).join("")}</table>
<h2>Identical</h2><p>${results.filter((r) => !changed.includes(r)).map((r) => `${r.route} ${r.label} ${r.theme ?? ""}${r.capped ? ` (${r.capped})` : ""}`).join(" · ") || "none"}</p>`,
);
console.log(`\n${changed.length} of ${results.length} differ. Report: ${path.relative(ROOT, path.join(OUT, "index.html"))}`);
