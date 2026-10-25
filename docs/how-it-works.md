# How Doppel works (audit, 2026-10-25)

## Parts

| Command | File | What it does |
|---|---|---|
| `doppel up <refA> <refB>` | `up.mjs` | Makes two git worktrees, builds both, starts two servers |
| `doppel mirror` | `mirror.mjs` + `mirror-app/` | Electron window: A left, B right, input in A replayed in B |
| `doppel shots` | `shots.mjs` | Screenshot diff of `pages` x `sizes` -> `.doppel/<date>/index.html` |
| `doppel styles` | `styles.mjs` | Computed-style diff of one element subtree |

`cli.mjs` only dispatches to these files. `config.mjs` reads the project's
`doppel.config.mjs` (the only place that knows the project).

## `up`: where the left and right apps come from

1. The project is the git checkout you run from (or `--project <dir>`).
2. For each side, `up.mjs` runs `git worktree add --detach $TMPDIR/doppel-<name>-a|b <sha>`.
   The old worktree is removed first, every run.
3. `.` = HEAD + `git diff HEAD` applied + untracked files copied.
4. `link` paths (default `node_modules`) are symlinked from your checkout.
5. `build` runs in both (parallel), then `start` with `PORT=3141` / `3142`.
6. It polls `ready` until it answers, prints the URLs and waits. Ctrl+C kills both process groups.

Important: these are **production builds**, not dev servers. There is no hot reload.
After an edit, run `doppel up --only b HEAD .`. The mirror pane retries until the server is back.

Logs: `$TMPDIR/doppel-<name>-a.build.log`, `.serve.log`.

Current state: `arena-hw-bench` has a config (`next build` / `next start`), excluded through `.git/info/exclude`.
Worktrees `doppel-hw-bench-a|b` exist in `$TMPDIR`.

## `mirror`: the window

- `mirror.mjs` makes a copy of Electron.app named Doppel (Dock name), then starts `mirror-app/main.js`.
- Three `WebContentsView`s: toolbar, A (with `record.cjs` preload), B.
- `record.cjs` sends A's mouse/keys/wheel/scroll over IPC; `sync.js` replays them in B with `sendInputEvent`, scaled.
- Address sync: 700 ms after A navigates, B loads the same path if it differs.
- `viewport.js` emulates the screen size; both panes are scaled to fit.
- B gets focus emulation through the debugger, so `:focus-visible` shows.

`mirror` does not need `up`. It takes any two URLs:
`doppel mirror http://localhost:3000 http://localhost:3001 /path`.

## Manual use without an agent

A. Doppel manages the versions:
```
cd <project>
doppel up origin/main .      # terminal 1, keep open
doppel mirror                # terminal 2
```

B. You manage the versions (own worktrees, dev servers with hot reload):
```
git worktree add ../app-main origin/main
(cd ../app-main && npm run dev -- -p 3141)    # terminal 1
npm run dev -- -p 3142                        # terminal 2, your branch
doppel mirror                                 # uses the config's ports
```
Dev mode adds noise (dev overlays, slower first load), but it is fine for looking by eye.
`shots` should stay on `up` (production builds, stable).

## Gaps seen in the code (not tested)

- `up` and the servers live in one terminal. Close it and both servers stop.
- No command to point `up` at existing worktrees or to run `dev` instead of `build`+`start`.
- Worktrees always go to `$TMPDIR` and are recreated each run.

## Crash: leads to check (hypotheses, not verified)

- No crash reports for Doppel/Electron in `~/Library/Logs/DiagnosticReports`.
  So it may be a renderer crash or a clean exit, not a main-process crash.
- `main.js` has no `render-process-gone` / `unresponsive` handlers. A dead pane is not logged.
- `mirror.mjs` filters Chromium stderr lines `[pid:tid/...:ERROR...]`. The crash reason may be hidden there.
- `win.on("closed", () => app.quit())` - any window close ends the app.
- Done: every run now logs to `~/Library/Logs/Doppel/mirror-<time>.log` (`mirror-app/watch.js`).
  After the next crash, read the last lines of the newest log.
