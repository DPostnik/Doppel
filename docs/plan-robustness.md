# План правок по аудиту работоспособности (2026-10-25)

Источник: `docs/audit-2026-10-25.md`. Каждый этап - отдельный коммит.
Статусы: `[ ]` не начато, `[~]` в работе, `[x]` сделано и проверено.

Общая проверка после каждого этапа:
```
cd ~/Public/self-projects/doppel && for f in *.mjs mirror-app/*.js mirror-app/*.cjs; do node --check "$f"; done
cd ~/Public/work/acedia/arena-hw-bench && doppel up . . && doppel shots --pages / && doppel mirror --selftest
```

---

## Этап 1. `up.mjs`: порядок операций и ожидание порта (аудит п. 1, 2)

- [x] 1.1 Вынести проверку ref'ов из `prepare()` в отдельный шаг до kill:
  ```js
  for (const s of sides) s.sha = git(["rev-parse", "--verify", `${s.ref === "." ? "HEAD" : s.ref}^{commit}`]);
  ```
  Ошибка git здесь завершает `up` с кодом 2 и текстом `doppel up: unknown ref "<ref>"`.
  Серверы при этом не тронуты.
- [x] 1.2 Освобождение порта заменить функцией `freePort(port)`:
  1. `lsof -nP -a -iTCP:<port> -sTCP:LISTEN -Fpc` -> список pid + имя команды.
  2. Напечатать `freeing :3142 (pid 98681 next-server)`.
  3. `kill -TERM` каждому pid.
  4. Опрашивать lsof каждые 200 мс до 10 с; если занято - `kill -KILL`, ещё 2 с.
  5. Если порт всё ещё занят - выход с кодом 1 и сообщением `:3142 is still taken by pid N`.
  Реализовать через `execFileSync("lsof", [...])` без `sh -c`, чтобы порт не попадал в shell-строку.
- [x] 1.3 Порядок в файле: parse argv -> loadConfig -> проверка ref'ов -> freePort -> prepare -> install -> build -> start.
- [x] Проверка: `doppel up origin/nope .` при живых серверах - серверы живы, сообщение про ref.
  `doppel up --only b . .` дважды подряд с `build: null` в тестовом конфиге - второй запуск
  не даёт "stopped (code 1)".

## Этап 2. `up.mjs`: сироты и зависания (аудит п. 3, 18)

- [x] 2.1 `waitUp`: `fetch(url, { signal: AbortSignal.timeout(3000) })`.
- [x] 2.2 Обернуть запуск:
  ```js
  try { await Promise.all(sides.map(waitUp...)) } catch (e) { console.error(e.message); stop(1); }
  ```
  `stop(code)` убивает группы `process.kill(-p.pid)` и выходит с кодом.
- [x] 2.3 `process.on("uncaughtException")` и `process.on("unhandledRejection")` -> лог + `stop(1)`.
- [x] 2.4 `sh()`: `p.on("error", reject)`; закрывать fd лога в `exit`/`error`.
- [x] 2.5 Если сборка одной стороны упала, вторую сборку убить (`p.kill()` по общему `AbortController`), затем выход.
- [x] Проверка: конфиг с `ready: "/nope-500"` (сервер отвечает 500) -> через 120 с `up` выходит,
  `lsof -iTCP:3141` пуст. Конфиг со `start: "sleep 1000"` -> та же картина.

## Этап 3. `up.mjs`: имя worktree и копирование (аудит п. 4, 17)

- [x] 3.1 В `config.mjs` имя worktree: `doppel-<name>-<hash6(root)>-a`, где hash6 = первые 6 hex
  sha1 от `c.root`. `--name <suffix>` остаётся как есть.
- [x] 3.2 В `prepare()` перед `git worktree remove`: проверить `git worktree list --porcelain`;
  если `s.dir` не в списке, но существует - `fs.rmSync(s.dir, { recursive: true, force: true })`.
  Если `remove` всё равно бросил - тоже `rmSync` + `prune`, затем повторить `add`.
- [x] 3.3 Копирование untracked: `fs.lstatSync`; пропускать всё, что не файл и не symlink;
  symlink копировать как symlink (`fs.readlinkSync` + `symlinkSync`). Битые пропускать с предупреждением.
- [x] 3.4 `link`: если путь уже есть в worktree (трекается) - `rmSync` и затем symlink; создавать
  родительскую папку `mkdirSync(..., { recursive: true })`.
- [x] 3.5 README: раздел "Worktrees" - упомянуть хеш в имени и `git worktree prune`.
- [x] Проверка: создать пустую папку с именем будущего worktree -> `up` проходит.
  Добавить в проект битый symlink untracked -> `up` проходит с предупреждением.

## Этап 4. `shots.mjs` и `styles.mjs`: Chrome и предпроверка (аудит п. 7, 20, 19)

- [x] 4.1 Общий модуль `browser.mjs`:
  - `findChrome()`: `$CHROME` -> Google Chrome -> Chromium -> Brave -> Edge; если ничего -
    ошибка `set CHROME=<path to a Chrome binary>`.
  - `withBrowser(fn)`: launch, `try { await fn(browser) } finally { await browser.close() }`;
    SIGINT/SIGTERM -> `browser.close()` затем `process.exit(130)`.
  - `assertUp(urls)`: `fetch` каждого с таймаутом 3 с; при отказе -
    `A http://localhost:3141 does not answer; run \`doppel up\` first`, код 1.
- [x] 4.2 Перевести `shots.mjs` и `styles.mjs` на `browser.mjs`.
- [x] 4.3 Папка отчёта `shots`: `YYYY-MM-DD-HHmmss` локального времени; если существует - суффикс `-2`.
- [x] Проверка: `doppel shots` при выключенных серверах - одно сообщение, код 1, `pgrep -f "Google Chrome.*headless"` пуст.
  Ctrl+C посреди `shots` - процессов Chrome нет.

## Этап 5. `shots.mjs`: память (аудит п. 8)

- [x] 5.1 `MAX_H` 40000 -> 20000; в отчёт писать `height capped` когда страница длиннее.
- [x] 5.2 Параллелизм: воркеры = 3, но job с `w >= 2560` берёт "вес" 3 (семафор по весу),
  то есть 4k/2k выполняются по одному.
- [x] 5.3 В `compare`: не делать `pad` копий, когда высоты равны; `diff`-PNG создавать только
  если `n > 0` (сравнение через `pixelmatch` с `null` для output невозможно - делать два прохода:
  сначала `pixelmatch(..., null, ...)` для счёта, потом с буфером только при `n > 0`).
- [x] 5.4 Освобождать буферы (`a = b = null`) после записи файлов, чтобы GC мог забрать.
- [x] Проверка: `doppel shots` на hw-bench всех страниц при 4k; `/usr/bin/time -l` -> maximum resident
  set size меньше 2 ГБ.

## Этап 6. `mirror-app/main.js`: зависание и ошибки обработчиков (аудит п. 6, 12, 13, 14)

- [x] 6.1 Focus-эмуляция B: функция `enableFocus(wc)` с `Promise.race` таймаут 3 с; вызывать на
  первом `did-finish-load` B (флаг `focusDone`), а не после `Promise.all` загрузок.
- [x] 6.2 `theme`: порядок - `if (!THEMES) return;` затем `const cur = a.webContents.getURL();`
  если `!cur.startsWith(A)` - `loadURL(A + START + ?param=val)`; иначе `new URL(cur)`.
- [x] 6.3 Все `loadURL` в ipc-обработчиках и retry - с `.catch(() => {})`; сам обработчик
  `mirror:ctl` обернуть в try/catch с `log("ctl-error", { cmd, message })`.
- [x] 6.4 Retry после `did-fail-load`: перед `loadURL(url)` сравнить `url` с текущим `v.webContents.getURL()`;
  если текущий - другой адрес не chrome-error, не грузить.
- [x] 6.5 Правый клик: в `record.cjs` не отправлять `down/up` с `b === 2`; в `main.js`
  меню "Inspect" на B оставить (нужно для ручного правого клика в B).
- [x] 6.6 `watch.js`: `uncaughtException` в режиме `--selftest` -> `console.log("FAIL uncaught: ...")`
  и `app.exit(1)`; в обычном режиме - только лог (как сейчас).
- [x] Проверка: `doppel mirror` при выключенном B -> в терминале есть строка `mirror: A ... B ...`,
  после `doppel up --only b . .` в B появляются focus-кольца по Tab. Правый клик в A -> одно меню.
  Кнопка темы на пустом окне (оба сервера выключены) не даёт `uncaught` в логе.

## Этап 7. `mirror-app/sync.js`: двойная загрузка (аудит п. 11)

- [x] 7.1 В `onNav`: если `target.isLoading()` - отложить проверку ещё на 700 мс (до 5 раз), не грузить.
- [x] 7.2 Дополнительно слушать `did-navigate` на `target`: при совпадении путей отменять таймер.
- [x] Проверка: в selftest добавить check "click link: B navigates once" - считать `did-navigate` B
  за 3 с после клика по ссылке в A (ожидание 1).

## Этап 8. `selftest.js`: информативные ошибки (аудит п. 21)

- [x] 8.1 `center(sel)`: в JS внутри страницы вернуть `null`, если элемента нет; снаружи
  `throw new Error(\`selftest: no element for ${sel} in A\`)`.
- [x] 8.2 `click(sel)`: то же; `both(code)` - ловить ошибку выполнения и дополнять текст именем стороны.
- [x] 8.3 Таймер 180 с: по срабатыванию печатать, какой check был последним (хранить `lastCheck`).
- [x] Проверка: в hw-bench `doppel.selftest.mjs` временно указать несуществующий селектор ->
  FAIL с именем селектора за секунды, код 1.

## Этап 9. `cli.mjs`, `mirror.mjs`, `config.mjs`: пути и аргументы (аудит п. 9, 10, 15, 16)

- [x] 9.1 `fileURLToPath(import.meta.url)` в `cli.mjs` и `mirror.mjs`.
- [x] 9.2 `--ports`: ровно два целых 1..65535, иначе `doppel: --ports takes two ports, e.g. 3241,3242`, код 2.
  `--name`: только `[A-Za-z0-9._-]`.
- [x] 9.3 `mirror.mjs` установка Electron: сначала сообщение `doppel: Electron binary missing, running npm install in <dir>`;
  при ошибке - `run: cd <dir> && npm install && node node_modules/electron/install.js`, код 1.
- [x] 9.4 `codesign`: `stdio: ["ignore", "ignore", "pipe"]`, в ошибку включать stderr.
- [x] Проверка: `cp -R doppel "/tmp/dop pel"` и `node "/tmp/dop pel/cli.mjs" shots --help`-подобный вызов -> usage, не ENOENT.
  `doppel shots --ports 3141` -> сообщение про два порта.

## Этап 10. Гигиена и документация

- [x] 10.1 `package.json`: `"engines": { "node": ">=20" }`, `"scripts": { "check": "node --check ..." }`.
  Electron pin точный `45.0.0` (без `^`), с комментарием в README почему.
- [x] 10.2 `watch.js`: троттлинг `console-error` - не больше 20 записей в минуту на пане, затем одна строка `... N more`.
  `mirror.mjs`: буферизовать stderr Electron и писать раз в 500 мс.
- [x] 10.3 `shots.mjs`: имя файла - `encodeURIComponent(route).replace(/%/g, "_")`.
- [x] 10.4 `main.js` `go`: если ввод начинается с `http`, брать из него только `pathname+search+hash`.
- [x] 10.5 `record.cjs`: на `mouseleave` документа отправлять move в `(-1, -1)`, чтобы B снял hover.
- [x] 10.6 `docs/how-it-works.md`: убрать раздел "Crash: leads to check" или заменить на ссылку на логи;
  обновить "Gaps".
- [x] 10.7 README: раздел "Troubleshooting" - порт занят, worktree не удаляется, Chrome не найден, Electron не скачан.

---

## Порядок выполнения и оценка

| Этап | Приоритет | Оценка | Зависит от |
|---|---|---|---|
| 1 | высокий | 1 ч | - |
| 2 | высокий | 1 ч | 1 |
| 4 | высокий | 1 ч | - |
| 6 | высокий | 1.5 ч | - |
| 3 | средний | 1 ч | 1 |
| 5 | средний | 1 ч | 4 |
| 7 | средний | 0.5 ч | 6 |
| 8 | средний | 0.5 ч | - |
| 9 | средний | 0.5 ч | - |
| 10 | низкий | 1.5 ч | все |

Перед началом: закоммитить текущие изменения (README, config, main.js, selftest.js, mirror.mjs, up.mjs, watch.js, docs/).

---

## Результат (2026-10-25)

Все этапы сделаны четырьмя параллельными агентами в отдельных worktree и
влиты в main. Общая проверка на влитом main:

| Проверка | Результат |
|---|---|
| `npm run check` | ок |
| `mirror --selftest` на hw-bench (3341/3342) | all checks passed, 23 проверки, из них 5 новых |
| `shots --pages /,/about` на одинаковом коде | 0 of 10 differ |
| `up --only b` на живой паре | старый сервер освобождён, новый B поднят, A не тронут |
| `up --only b` дважды с `build: null` | `freeing :3362`, без EADDRINUSE |
| `shots` всех 11 страниц, все 5 размеров (этап 5) | 0 of 55 differ, 131 с, пик памяти 1.34 ГБ (цель < 2 ГБ) |

Отклонения от плана (по сути улучшения):
- 2.5: вместо AbortController каждый дочерний процесс в своей группе; выход `up` убивает все группы.
- 3.4: `link` создаётся последним; untracked-файлы под `link` не копируются (иначе запись шла бы через symlink в checkout).
- 6.5: Ctrl-клик на macOS тоже не зеркалится (это правый клик).
- 7.2: B отменяет догоняющую загрузку и по `did-navigate-in-page` (клиентский роутинг Next).
- 9.3, 9.4: битый пакет Electron даёт то же сообщение; при сбое codesign копия Doppel.app удаляется.
- 10.4: полный URL распознаётся по `^https?:`.
- Сверх плана: отчёт `styles` назван по локальному времени до секунды, как `shots`.

Не проверено:
- Обрезка по 20000 px на hw-bench не срабатывает (самая длинная страница 11810 px); проверено копией с `MAX_H = 3000`.
- Реальное контекстное меню и Ctrl-клик руками; selftest считает меню, но не показывает их.
- Другие ОС, кроме macOS.

Что изменилось для пользователя:
- Имена worktree теперь `doppel-<name>-<hash6>-a|b`. Старые `doppel-<name>-a|b` больше не удаляются автоматически: `git worktree remove <dir>`.
