# pi-model-lock

> ⚠️ **Lock proven on pi 0.75.0–0.87.1 only.** On pi ≥ 0.99.0, pi itself makes `/model` session-scoped (settings.json no longer changes), so this extension detects the new version and runs **warn-only** there — it does nothing except point you at the built-in replacement. See [pi version behavior](#pi-version-behavior). Safe to remove on pi ≥ 0.99.0.

A [pi](https://pi.dev) extension that prevents `/model` (and `Ctrl+P` model cycling / `Ctrl+L` model selector) from persisting the switched-to model as the global default in `~/.pi/agent/settings.json`.

**Version-aware:** on pi ≤ 0.87.1 the extension does its full job (see below). On pi ≥ 0.99.0 it detects the running version and becomes **warn-only**: it registers no hooks and its commands just point at the built-in replacements, because pi itself made model switches session-scoped.

## Why

pi's `setModel()` unconditionally writes the new model to `settings.json`. A one-off switch silently becomes the default for every future session. There is no upstream opt-out (see pi issues [#5976](https://github.com/earendil-works/pi/issues/5976), [#4002](https://github.com/earendil-works/pi/issues/4002), [#5255](https://github.com/earendil-works/pi/issues/5255)). This extension restores the previous default after pi's write lands --- the in-session model still changes; only the persisted default is preserved.

As far as I can tell, `/model` is the only interface that changes settings.json outside of `/settings` - and `defaultModel` suggests it should be a fixed configuration value instead of a toggle - but so far the team have not been interested in fixing this.

## pi version behavior

| pi version | What this extension does |
| --- | --- |
| ≤ 0.87.1 | Full lock: snapshot settings, observe pi's write, restore `event.previousModel`. `/model-save` writes the default once. |
| ≥ 0.99.0 | Warn-only. pi's `setModel()` gained an `options.persist` gate (default off): `/model` switches are session-scoped and never touch settings.json. The only path that persists is the model picker's explicit **set as default** action. |

On pi ≥ 0.99.0 the built-in replacements are:

- **Lock** → nothing needed; `/model` is already session-scoped.
- **`/model-save`** → model picker (`Ctrl+L`) → pick a model → `Ctrl+S` (**"set as default"**).

Commands still respond in warn mode so you are never left guessing; the version is detected from the running pi installation (no deep imports, no sidecar files). If the version cannot be determined, the extension falls back to full lock behavior — correct for every pi that needs it.

## Risk

This is a bit of a hack - pi writes the settings.json and then we write it again.  There's no better way to do this due to what's exposed to the extension system.

There is some concurrency risk if you were to `/model` (or other) change in multiple sessions concurrently.   And there is definitely a problem when you have sessions that have not yet loaded this extension.

## Design

This new functionality is on by default - it's this authors opinion that this should have been default behavior anyway.   If you want to turn it off, `/model-lock off` will turn it off and retain that for the session (persists across reload/resume but not new.)

## Load order requirement (important)

This extension depends on being the **first** extension to handle the `model_select` event. The restore logic snapshots `settings.json` synchronously at the top of its handler, before any `await`. It works because pi (0.75.x) queues its settings write as a microtask that only flushes when the event-loop yields — and the emit loop yields at the first `await` of the first async handler for that event.

If another extension registered earlier in your `packages` list has an async `model_select` handler (any handler that awaits), the runner's `await` will flush pi's settings write to disk before this extension's handler runs. The snapshot then sees the *new* model and the lock silently becomes a no-op (worse: it restores the wrong value if it uses fallbacks).

Fix: keep this extension at the **top** of the `packages` array in `~/.pi/agent/settings.json`, above any extension with a `model_select` handler (e.g. `pi-codex-accounts`).

Symptom if order is wrong: `/model-lock debug on`, switch models, and the log shows `file at entry` equal to the model you just switched TO — meaning pi's write landed before this handler ran.




## Commands

| Command | Description |
| --- | --- |
| `/model-lock` | Show lock status (pi ≥ 0.99.0: explains it's not needed and names the built-in replacement) |
| `/model-lock on` \| `off` | Enable / disable restore (default: ON; no-op on pi ≥ 0.99.0) |
| `/modellock` | Alias, caught silently (not in slash menu) |
| `/model-save` | Persist the CURRENT session model as the new global default (one-time write; lock state unchanged). pi ≥ 0.99.0: replaced by the picker's set-as-default action (`Ctrl+L` → `Ctrl+S`) |
| `/modelsave` | Alias, caught silently (not in slash menu) |
| `/model-lock debug [on\|off]` | Toggle debug logging for this session (not advertised in the command description; no arg toggles) |
| `/modellock debug` | Alias, caught silently |

### Per-session state

Lock on/off AND debug on/off persist across `/reload` of the same session, reset on `/new` and `/fork` (those start new session files). State is stored via `pi.appendEntry` into the session file --- one session flipping its lock or debug does **not** affect other concurrent sessions.

## Usage notes

- **Want to intentionally change the default?** Either hand-edit `settings.json`, or use `/model-save` after switching in-session --- no need to toggle the lock off.
- **Lock vs debug:** the lock *work* (read snapshot, poll for pi's write, restore) always runs --- that's the cheap part; if you don't want even that, don't load the extension. *File logging* and the *TUI log pointer* are gated on the debug flag, which defaults off and is toggled per-session via `/model-lock debug`.
- **Log file** (when debug on): `~/.pi/agent/model-lock/debug.log`

## Install

```bash
pi install git:github.com/keen99/pi-model-lock
```

## License

MIT

## Development

```sh
npm install
npm run check          # typecheck + unit tests (sandboxed settings, nothing real touched)
npm run test:matrix    # RPC smoke against every published pi release >= 0.75.0 (cached installs)
node test/rpc-smoke.mjs  # quick single-version smoke
```

- Tests resolve settings through `PI_CODING_AGENT_DIR`; point it at a temp dir and nothing outside is touched.
- Unit tests simulate pi's settings write during `model_select` to exercise the restore poll.
- `PI_TEST_BIN` overrides the pi binary used by smokes.
- `PI_MATRIX` limits matrix versions; `PI_MATRIX_INCLUDE_PRERELEASE=1` adds rc/beta tags.
