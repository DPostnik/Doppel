/**
 * Headless Chrome for shots and styles: find a binary, check that A and B
 * answer before launching, and close Chrome on any way out (error, Ctrl+C).
 */
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const CANDIDATES = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/brave-browser", "/usr/bin/microsoft-edge"],
  win32: [
    `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.PROGRAMFILES}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    `${process.env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ],
};

export function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const hit = (CANDIDATES[process.platform] || []).find((p) => fs.existsSync(p));
  if (hit) return hit;
  console.error("doppel: no Chrome, Chromium, Brave or Edge found; set CHROME=<path to a Chrome binary>");
  process.exit(1);
}

// One clear message instead of a report made only of ERR_CONNECTION_REFUSED.
// Any HTTP status counts as an answer: a 404 or 500 page is still worth a diff.
export async function assertUp(urls) {
  const down = [];
  await Promise.all(
    Object.entries(urls).map(async ([side, url]) => {
      try {
        await fetch(url, { signal: AbortSignal.timeout(3000) });
      } catch {
        down.push(`${side} ${url} does not answer; run \`doppel up\` first`);
      }
    }),
  );
  if (down.length) {
    for (const m of down.sort()) console.error(m);
    process.exit(1);
  }
}

// Runs fn(browser) and closes Chrome however it ends. Puppeteer's own signal
// handlers are off: on SIGTERM it closes Chrome but leaves node running.
export async function withBrowser(fn) {
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ["--hide-scrollbars", "--font-render-hinting=none"],
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  let quitting = false;
  const quit = async () => {
    quitting = true;
    console.error("\ndoppel: interrupted, closing Chrome");
    // A hung close must not keep the process alive; kill Chrome's process
    // group (puppeteer starts it detached) after 3 s.
    const pid = browser.process()?.pid;
    const kill = setTimeout(() => { try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch {} }, 3000);
    await browser.close().catch(() => {});
    clearTimeout(kill);
    process.exit(130);
  };
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(s, quit);
  // Once quit() runs, the jobs fail with "Target closed"; hold the caller so
  // it does not write a report of those failures before quit() exits.
  const hold = () => new Promise(() => {});
  try {
    const out = await fn(browser);
    if (quitting) await hold();
    return out;
  } catch (e) {
    if (quitting) await hold();
    throw e;
  } finally {
    for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(s, quit);
    await browser.close().catch(() => {});
  }
}
