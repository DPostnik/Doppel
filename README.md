# Doppel

Compare two versions of a web app. Doppel builds and serves both from git
worktrees, diffs screenshots of every page at several screen sizes, and opens
both side by side in one window, where whatever you do in the left one is
replayed in the right one.

```
doppel up <refA> <refB>        # A on :3141, B on :3142, e.g. `doppel up origin/main .`
doppel shots [--all-themes]    # screenshot diff -> .doppel/<date>/index.html
doppel mirror [--selftest]     # one window: A left, B right, input mirrored
```

Doppel works on the git checkout you run it from; everything it needs to know
about that project is in the project's `doppel.config.mjs`.

## Install

```
git clone https://github.com/DPostnik/Doppel.git ~/Public/self-projects/doppel
cd ~/Public/self-projects/doppel && npm install && npm link   # puts `doppel` on PATH
```

Without `npm link`, run `node <doppel>/cli.mjs <command>`, or a tool directly:
`node <doppel>/up.mjs ...`. macOS with Google Chrome installed (for `shots`;
set `CHROME` to use another binary). `mirror` brings its own Electron.

## The two versions: git worktrees

A worktree is a second checkout of the same repository in another folder. It
shares the `.git` data (no clone, no download) but has its own files, so two
versions can be built and run at the same time without touching your
checkout.

`doppel up <refA> <refB>` makes one worktree per side in the system temp folder
(`doppel-<name>-a`, `-b`), each detached at its ref, then installs or links
dependencies, builds and starts both. A ref is anything git accepts:

| you want to compare | command |
|---|---|
| your uncommitted work against the last commit | `doppel up HEAD .` |
| your branch (with uncommitted work) against main | `doppel up origin/main .` |
| two commits | `doppel up 8ae68ad 1bae9bc` |
| calibration: the same code on both sides | `doppel up . .` |

`.` means your checkout as it is now: the last commit plus uncommitted edits
plus untracked files, copied into the worktree. Every other ref is the
committed state only.

Run the same version on both sides (`doppel up . .`) once when you set a
project up: `doppel shots` must then report 0 differences. Anything it reports later is a
real change, not noise (fonts loading late, animations, random data). If it
does report something on identical code, fix that first (see "Noise" below).

Notes:
- The worktrees are throwaway: `doppel up` removes and recreates them each run.
  Do not edit or commit in them. `git worktree list` shows them; `git worktree
  prune` forgets ones whose folder is gone.
- Dependencies are linked from your checkout (`link`, default `node_modules`)
  rather than installed again, which takes seconds instead of minutes. If the
  two refs need different dependencies, set `install` (e.g. `npm ci`) instead.
- Logs: `<tmp>/doppel-<name>-a.build.log`, `.serve.log`.
- `doppel up --only b <refA> <refB>` rebuilds one side and leaves the other running.
- `doppel up --annotate ...` adds the config's `annotate` env to side B only,
  to switch on a review tool there (see below).
- Ctrl+C stops both servers.

## Adding a project

1. Write `doppel.config.mjs` in the project root:

```js
export default {
  name: "my-app",                          // worktree folder names
  build: "npm run build",                  // null if nothing to build
  start: "npm run start -- --port $PORT",  // must serve on $PORT
  ready: "/",                              // answers once the server is up
  pages: ["/", "/pricing", "/docs"],       // what `doppel shots` shoots
  theme: { param: "theme", values: ["dark", "light"] }, // or null
  selftest: "./doppel.selftest.mjs",       // optional, see below
  annotate: { NEXT_PUBLIC_REMARQ: "1" },   // optional, see below
};
```

   All keys and their defaults are in `config.mjs` (`DEFAULTS`): `link`,
   `install`, `ports`, `env`, `sizes`, `reducedMotion`.

2. Add `.doppel/` to the project's `.gitignore` (screenshot reports). To keep
   the config out of the project's history too, list `doppel.config.mjs` and
   `doppel.selftest.mjs` in `.git/info/exclude` instead of committing them.

3. Check it: `doppel up . .`, then `doppel shots` (expect 0 differences), then
   `doppel mirror --selftest` (generic checks: sizes, scroll, DevTools, theme).

### A review widget in B (optional)

A dev-only tool such as an annotation widget is not in a production build.
To have it in the B pane anyway, let the project switch it on by an env
variable at build time, name that variable in `annotate`, and run
`doppel up --annotate <refA> <refB>`. Only B gets it: input in A is replayed
in B, so a widget on both sides would act twice. Use it in B directly. Leave
`--annotate` off for `doppel shots`, or B's screenshots show the widget.

### Project checks for `--selftest` (optional)

The generic checks need no selectors. To also test your own UI (a menu, a
dialog, a form), point `selftest` at a module whose default export gets the
helpers:

```js
export default async function (t) {
  await t.click("header .menu-button");             // real click in A
  await t.wait(800);
  t.check("menu opens", await t.both(`document.querySelector(".menu").hidden`), false);
}
```

`t.both(js)` runs an expression in A and B and returns both results;
`t.check(name, [a, b], want)` passes when they agree (and equal `want`).
Also `t.key`, `t.center`, `t.js`, `t.setPreset`, `t.a`/`t.b` (the panes'
webContents). See `mirror-app/selftest.js`.

## Noise

Things that make identical code look different in `doppel shots`, and what to do:
- Entrance animations: `reducedMotion: true` (default) asks the site to skip
  them; the site has to honour `prefers-reduced-motion`.
- Lazy content: each page is scrolled through before shooting.
- Time or random data on the page: make it fixed in the build you compare, or
  leave that page out of `pages`.

## The mirror window

`doppel mirror` opens one window (Electron): toolbar on top, A left, B right.
What you do in A (mouse, wheel, keys, page scroll, address) is replayed in B
as real input, so hover and focus show in both. Toolbar: back, forward,
reload both; an address field; screen sizes (4K ... phone, or type any size
like `1280x800`), each scaled to fit; `fill` keeps the size's width and uses
the pane's full height; the theme buttons; DevTools under A or B (also
Cmd+Opt+I in A, or right-click > Inspect).

If the window crashes or a pane goes blank, look at the run's log:
`~/Library/Logs/Doppel/mirror-<time>.log` (the last 30 runs). It has pane and
process crashes, hangs, uncaught errors, page console errors, memory once a
minute, Chromium's full stderr and the exit code; native crash dumps go to
`crashdumps/` next to it.

Pieces, if you want them elsewhere: `mirror-app/sync.js` replays input from
one webContents in another; `mirror-app/viewport.js` emulates the sizes;
`mirror-app/record.cjs` is the recording preload. None of them knows the site.
