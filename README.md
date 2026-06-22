# pi-model-lock

A [pi](https://pi.dev) extension that prevents `/model` (and `Ctrl+P` model cycling / `Ctrl+L` model selector) from persisting the switched-to model as the global default in `~/.pi/agent/settings.json`.

## Why

pi's `setModel()` unconditionally writes the new model to `settings.json`. A one-off switch silently becomes the default for every future session. There is no upstream opt-out (see pi issues [#5976](https://github.com/earendil-works/pi/issues/5976), [#4002](https://github.com/earendil-works/pi/issues/4002), [#5255](https://github.com/earendil-works/pi/issues/5255)). This extension restores the previous default after pi's write lands --- the in-session model still changes; only the persisted default is preserved.

As far as I can tell, `/model` is the only interface that changes settings.json outside of `/settings` - and `defaultModel` suggests it should be a fixed configuration value instead of a toggle - but so far the team have not been interested in fixing this.

## Risk

This is a bit of a hack - pi writes the settings.json and then we write it again.  There's no better way to do this due to what's exposed to the extension system.

There is some concurrency risk if you were to `/model` (or other) change in multiple sessions concurrently.   And there is definitely a problem when you have sessions that have not yet loaded this extension.

## Design

This new functionality is on by default - it's this authors opinion that this should have been default behavior anyway.   If you want to turn it off, `/model-lock off` will turn it off and retain that for the session (persists across reload/resume but not new.)



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
