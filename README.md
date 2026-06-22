# pi-model-lock

A [pi](https://pi.dev) extension that prevents `/model` (and `Ctrl+P` model cycling / `Ctrl+L` model selector) from persisting the switched-to model as the global default in `~/.pi/agent/settings.json`.

## Why

pi's `setModel()` unconditionally writes the new model to `settings.json`. A one-off switch silently becomes the default for every future session. There is no upstream opt-out (see pi issues #4002, #5255). This extension restores the previous default after pi's write lands — the in-session model still changes; only the persisted default is preserved.

## Commands

| Command | Description |
| --- | --- |
| `/model-lock` | Show lock status |
| `/model-lock on` \| `off` | Enable / disable restore (default: ON) |
| `/modellock` | Alias, caught silently (not in slash menu) |
| `/model-save` | Persist the CURRENT session model as the new global default (one-time write; lock state unchanged) |
| `/modelsave` | Alias, caught silently (not in slash menu) |
| `/model-lock debug [on\|off]` | Toggle debug logging for this session (not advertised in the command description; no arg toggles) |
| `/modellock debug` | Alias, caught silently |

### Per-session state

Lock on/off AND debug on/off persist across `/reload` of the same session, reset on `/new` and `/fork` (those start new session files). State is stored via `pi.appendEntry` into the session file — one session flipping its lock or debug does **not** affect other concurrent sessions.

## Usage notes

- **Want to intentionally change the default?** Either hand-edit `settings.json`, or use `/model-save` after switching in-session — no need to toggle the lock off.
- **Lock vs debug:** the lock *work* (read snapshot, poll for pi's write, restore) always runs — that's the cheap part; if you don't want even that, don't load the extension. *File logging* and the *TUI log pointer* are gated on the debug flag, which defaults off and is toggled per-session via `/model-lock debug`.
- **Log file** (when debug on): `~/.pi/agent/model-lock/debug.log`

## Install

```bash
pi install git:github.com/keen99/pi-model-lock
```

## License

MIT
