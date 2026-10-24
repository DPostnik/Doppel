#!/usr/bin/env node
/**
 * Computed-style diff of part of a page between two versions: every element
 * under the --root selectors, all computed properties plus ::before/::after and
 * the box, in a normal pass (each width and theme) and a forced :hover /
 * :focus-visible pass on each link, button and field. Catches what screenshots
 * miss: hover and focus styles, transitions, invisible declarations.
 *
 *   doppel styles --root <selector> [--root ...] [--path /about] [--click <selector>]
 *                 [--widths 1920,1280,1000,768,390] [urlA urlB]
 *
 * Elements are matched by DOM position under each root (the n-th match of the
 * selector on each side), not by class, so a component moved to a CSS Module
 * (new class names) still lines up. --click clicks an element (in both, in
 * order) before measuring, to open a menu or dialog. Writes the report to
 * stdout and .doppel/styles-<date-time>.txt.
 */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { loadConfig, ownArgs } from "./config.mjs";

const c = await loadConfig();
const argv = ownArgs(process.argv.slice(2));
const VALUED = ["--path", "--root", "--click", "--widths"];
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const all = (n) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]] : []));
const pos = argv.filter((a, i) => !a.startsWith("--") && !VALUED.includes(argv[i - 1]));
const A = (pos[0] || c.urls[0]).replace(/\/$/, "");
const B = (pos[1] || c.urls[1]).replace(/\/$/, "");
const PATH = opt("--path", "/");
const ROOTS = all("--root");
const CLICKS = all("--click");
if (!ROOTS.length) {
  console.error("usage: doppel styles --root <selector> [--root ...] [--path /p] [--click <selector>] [--widths 1920,390]");
  process.exit(2);
}
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
fs.mkdirSync(c.out, { recursive: true });
const OUT = path.join(c.out, `styles-${stamp}.txt`);
const WIDTHS = opt("--widths", "1920,1280,1000,768,390").split(",").map(Number);
const THEMES = c.theme ? c.theme.values : [null];
const HEIGHT = 900;
const MAX_FORCED = 80; // links/buttons/fields forced per run
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--hide-scrollbars", "--font-render-hinting=none"] });

/* ---------- in-page code ---------- */

// Installs window.__doppel with walk/collect helpers.
function install(roots) {
  const r1 = (v) => Math.round(v * 10) / 10;
  const isSvg = (el) => typeof SVGElement !== "undefined" && el instanceof SVGElement;
  function walk() {
    const out = [];
    const rec = (el, key) => {
      out.push([key, el]);
      if (isSvg(el)) return; // svg is a leaf
      Array.from(el.children).forEach((ch, i) => rec(ch, key + "." + i));
    };
    roots.forEach((sel, ri) => document.querySelectorAll(sel).forEach((el, i) => rec(el, `${ri}-${i}`)));
    return out;
  }
  function dump(cs, forced) {
    const o = {};
    for (let i = 0; i < cs.length; i++) {
      const n = cs[i];
      if (n.startsWith("--")) continue;
      if (forced && (n.startsWith("transition") || n.startsWith("animation"))) continue;
      o[n] = cs.getPropertyValue(n);
    }
    return o;
  }
  function record(el, forced) {
    const r = el.getBoundingClientRect();
    const res = {
      tag: el.tagName.toLowerCase(),
      cls: el.getAttribute("class") || "",
      rect: [r.x, r.y, r.width, r.height].map((v) => r1(v).toFixed(1)).join(","),
      style: dump(getComputedStyle(el), forced),
    };
    for (const p of ["::before", "::after"]) {
      const cs = getComputedStyle(el, p);
      const c = cs.getPropertyValue("content");
      res[p] = c === "none" || c === "normal" || c === "" ? { content: c } : dump(cs, forced);
    }
    return res;
  }
  window.__doppel = {
    collect(forced, prefix) {
      const o = {};
      for (const [k, el] of walk()) {
        if (prefix != null && k !== prefix && !k.startsWith(prefix + ".")) continue;
        o[k] = record(el, forced);
      }
      return o;
    },
    interactive() {
      const list = walk().filter(([, el]) => el.matches("a[href], button, input, select, textarea, summary, [tabindex]"));
      window.__doppelEls = list.map(([, el]) => el);
      return list.map(([k]) => k);
    },
  };
}

/* ---------- driver ---------- */

async function openPage(base, { width, theme, reduced }) {
  const ctx = await browser.createBrowserContext(); // fresh storage each time
  const page = await ctx.newPage();
  await page.setViewport({ width, height: HEIGHT, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }]);
  const url = base + PATH + (theme ? (PATH.includes("?") ? "&" : "?") + `${c.theme.param}=${theme}` : "");
  try {
    await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
  } catch (e) {
    if (!/timeout/i.test(e.message)) throw e;
    await page.goto(url, { waitUntil: "load", timeout: 60000 });
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    scrollTo(0, 0);
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    await new Promise((r) => setTimeout(r, 800));
  });
  for (const sel of CLICKS) {
    const ok = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }, sel);
    if (!ok) return { ctx, page, missing: sel };
    await page.click(sel);
    await sleep(1200);
  }
  await page.evaluate(install, ROOTS);
  return { ctx, page };
}

async function runState(base, sc) {
  const { ctx, page, missing } = await openPage(base, sc);
  try {
    if (missing) return { missing };
    return await page.evaluate(() => window.__doppel.collect(false, null));
  } finally {
    await ctx.close();
  }
}

// Forced pseudo-state pass: one element at a time, transitions disabled.
async function runForced(base, sc) {
  const { ctx, page, missing } = await openPage(base, sc);
  const res = { hover: {}, focus: {}, skipped: 0 };
  try {
    if (missing) return { missing };
    await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
    await sleep(100);
    const cdp = await page.createCDPSession();
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    await cdp.send("DOM.getDocument", { depth: 0 });
    const keys = await page.evaluate(() => window.__doppel.interactive());
    res.skipped = Math.max(0, keys.length - MAX_FORCED);
    for (let i = 0; i < Math.min(keys.length, MAX_FORCED); i++) {
      const { result } = await cdp.send("Runtime.evaluate", { expression: `window.__doppelEls[${i}]` });
      const { nodeId } = await cdp.send("DOM.requestNode", { objectId: result.objectId });
      for (const [state, classes] of [["hover", ["hover"]], ["focus", ["focus", "focus-visible"]]]) {
        await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: classes });
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));
        Object.assign(res[state], await page.evaluate((k) => window.__doppel.collect(true, k), keys[i]));
        await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
      }
    }
    await cdp.detach();
    return res;
  } finally {
    await ctx.close();
  }
}

/* ---------- scenarios ---------- */

const scenarios = [];
for (const w of WIDTHS) for (const t of THEMES) scenarios.push({ name: `${w}${t ? " " + t : ""}`, width: w, theme: t });
scenarios.push({ name: `${WIDTHS.at(-1)} reduced-motion`, width: WIDTHS.at(-1), theme: THEMES[0], reduced: true });
const forcedRuns = [];
for (const w of WIDTHS) forcedRuns.push({ name: `${w}`, width: w, theme: THEMES[0] });
if (THEMES.length > 1) for (const w of [WIDTHS[0], WIDTHS.at(-1)]) forcedRuns.push({ name: `${w} ${THEMES[1]}`, width: w, theme: THEMES[1] });

/* ---------- compare ---------- */
const diffs = []; // {scenario, key, tag, clsA, clsB, prop, a, b}
const structural = []; // {scenario, msg}
const notes = [];
let compared = 0;
const clean = [];

function flatten(r) {
  const o = { rect: r.rect, ...r.style };
  for (const p of ["::before", "::after"]) for (const [k, v] of Object.entries(r[p])) o[`${p} ${k}`] = v;
  return o;
}

function keyOrder(x, y) {
  const a = x.split(/[.-]/).map(Number), b = y.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function compare(scenario, ra, rb) {
  compared++;
  let n = 0;
  const keys = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort(keyOrder);
  for (const k of keys) {
    const a = ra[k], b = rb[k];
    if (!a || !b) {
      structural.push({ scenario, msg: `${k}: only in ${a ? "A" : "B"} (<${(a || b).tag} class="${(a || b).cls}">)` });
      n++;
      continue;
    }
    if (a.tag !== b.tag) {
      structural.push({ scenario, msg: `${k}: tag A <${a.tag} class="${a.cls}"> vs B <${b.tag} class="${b.cls}">` });
      n++;
      continue;
    }
    const fa = flatten(a), fb = flatten(b);
    for (const p of [...new Set([...Object.keys(fa), ...Object.keys(fb)])]) {
      if (fa[p] === fb[p]) continue;
      diffs.push({ scenario, key: k, tag: a.tag, clsA: a.cls, clsB: b.cls, prop: p, a: fa[p] ?? "(absent)", b: fb[p] ?? "(absent)" });
      n++;
    }
  }
  if (!n) clean.push(scenario);
}

/* ---------- run ---------- */

for (const sc of scenarios) {
  process.stderr.write(`run ${sc.name}\n`);
  try {
    const [ra, rb] = await Promise.all([runState(A, sc), runState(B, sc)]);
    if (ra.missing && rb.missing) { notes.push(`${sc.name}: skipped (${ra.missing} not visible in either)`); continue; }
    if (ra.missing || rb.missing) { compared++; structural.push({ scenario: sc.name, msg: `${(ra.missing || rb.missing)} visible only in ${ra.missing ? "B" : "A"}` }); continue; }
    compare(sc.name, ra, rb);
  } catch (e) {
    notes.push(`${sc.name}: ERROR ${e.message}`);
  }
}
for (const sc of forcedRuns) {
  process.stderr.write(`run forced ${sc.name}\n`);
  try {
    const [ra, rb] = await Promise.all([runForced(A, sc), runForced(B, sc)]);
    if (ra.missing || rb.missing) { notes.push(`forced ${sc.name}: skipped (${ra.missing || rb.missing} not visible)`); continue; }
    if (ra.skipped) notes.push(`forced ${sc.name}: only the first ${MAX_FORCED} interactive elements (${ra.skipped} more); narrow --root`);
    compare(`${sc.name} :hover`, ra.hover, rb.hover);
    compare(`${sc.name} :focus-visible`, ra.focus, rb.focus);
  } catch (e) {
    notes.push(`forced ${sc.name}: ERROR ${e.message}`);
  }
}
await browser.close();

/* ---------- report ---------- */

const L = [];
L.push(`Computed-style diff  A ${A}  vs  B ${B}  path ${PATH}  roots ${ROOTS.join(" | ")}${CLICKS.length ? "  after clicking " + CLICKS.join(", ") : ""}`);
L.push(`Scenarios compared: ${compared}. Viewport height ${HEIGHT}, DPR 1. Keys: root-match.child.child...`);
L.push("");

// group identical diffs (key+prop+a+b) across scenarios, then bucket by scenario set
const groups = new Map();
for (const d of diffs) {
  const id = JSON.stringify([d.key, d.prop, d.a, d.b]);
  if (!groups.has(id)) groups.set(id, { ...d, scenarios: [] });
  groups.get(id).scenarios.push(d.scenario);
}
const bySet = new Map();
for (const g of groups.values()) {
  const s = g.scenarios.join(", ");
  if (!bySet.has(s)) bySet.set(s, []);
  bySet.get(s).push(g);
}
const sets = [...bySet.entries()].sort((x, y) => y[1][0].scenarios.length - x[1][0].scenarios.length);

if (structural.length) {
  L.push("== STRUCTURAL MISMATCHES ==");
  for (const s of structural) L.push(`  [${s.scenario}] ${s.msg}`);
  L.push("");
}
for (const [set, gs] of sets) {
  const n = gs[0].scenarios.length;
  L.push(`== ${n > 1 ? `${n} scenarios: ` : "Scenario: "}${set} ==`);
  gs.sort((x, y) => keyOrder(x.key, y.key) || x.prop.localeCompare(y.prop));
  let last = null;
  for (const g of gs) {
    if (g.key !== last) {
      last = g.key;
      L.push(`  [${g.key}] <${g.tag}>  A class="${g.clsA}"  B class="${g.clsB}"`);
    }
    L.push(`      ${g.prop}:  A ${g.a}  |  B ${g.b}`);
  }
  L.push("");
}
if (clean.length) L.push(`Identical: ${clean.join(", ")}`, "");
if (notes.length) { L.push("Notes:"); for (const n of notes) L.push(`  ${n}`); L.push(""); }
const els = new Set(diffs.map((d) => d.key));
L.push(`TOTAL: ${diffs.length} property diffs (${groups.size} unique) on ${els.size} elements, ${structural.length} structural, ${compared - clean.length} of ${compared} scenarios differ.`);

const text = L.join("\n");
fs.writeFileSync(OUT, text + "\n");
console.log(text);
console.log(`\nReport: ${path.relative(c.root, OUT)}`);
