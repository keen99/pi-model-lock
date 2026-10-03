/**
 * model-lock v3: restore defaultModel after /model change.
 *
 * Strategy: in model_select handler, snapshot file value, wait for pi's
 * write to land (poll until file = event.model), then restore snapshot.
 *
 * Commands:
 *   /model-lock              — show status
 *   /model-lock on|off       — toggle restore
 *   /modellock               — alias, caught silently (no menu entry)
 *   /model-save              — persist CURRENT session model as new global
 *                              default (one-time write, lock unchanged)
 *   /modelsave               — alias, caught silently (no menu entry)
 *   /model-lock debug [on|off] — toggle debug logging for this session
 *                              (NOT advertised in the command description;
 *                               no arg = toggle; persists across /reload of
 *                               the session; resets on /new and /fork)
 *   /modellock debug         — alias, caught silently (no menu entry)
 *
 * Per-session state: lock on/off AND debug on/off persist across /reload of
 * the SAME session, reset on /new and /fork (those start new session files).
 * State is stored via pi.appendEntry into the session file — same pattern as
 * pi-git-safe-write. One session flipping its lock/debug does NOT affect
 * other concurrent sessions.
 *
 * Logging: the lock WORK (read, poll, restore) always runs — that's the
 * cheap part; if you don't want it, don't load the extension. File logging
 * and the TUI log pointer are gated on debug, which defaults off and is
 * toggled per-session via /model-lock debug.
 * Log file (when debug on): ~/.pi/agent/model-lock/debug.log
 *
 * Uninstall: rm -rf ~/.pi/agent/extensions/model-debug
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Resolved per call so tests can point PI_CODING_AGENT_DIR at a sandbox.
const settingsPath = () => join(getAgentDir(), "settings.json");
// Default for the per-session debug flag. Flip to true to default-debug every
// new session; otherwise toggle at runtime with /model-lock debug.
const DEBUG_DEFAULT = false;

const DATA_DIR = join(homedir(), ".pi", "agent", "model-lock");
const LOG = join(DATA_DIR, "debug.log");

const LOCK_KEY = "model-lock-locked";
const DEBUG_KEY = "model-lock-debug";

interface LockState {
  locked: boolean;
}

interface DebugState {
  debug: boolean;
}

function readSettings(): any {
  return JSON.parse(readFileSync(settingsPath(), "utf-8"));
}

function writeSettings(s: any): void {
  writeFileSync(settingsPath(), JSON.stringify(s, null, 2) + "\n", "utf-8");
}

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(raw: string | undefined): "on" | "off" | "status" | null {
  const a = (raw || "").trim().toLowerCase();
  if (!a || a === "status") return "status";
  if (a === "on") return "on";
  if (a.startsWith("of")) return "off"; // off, of
  if (a.startsWith("s")) return "status"; // status, s, st, stat...
  return null;
}

export default function (pi: ExtensionAPI) {
  let locked = true; // default ON; refined to persisted value on session_start
  let debug = DEBUG_DEFAULT;

  // Log to file only when debug is on.
  function log(line: string): void {
    if (!debug) return;
    ensureDir();
    appendFileSync(LOG, line + "\n", "utf-8");
  }

  // Append the log path to a TUI message only when debug is on.
  function logHint(): string {
    return debug ? " | log: " + LOG : "";
  }

  // Restore session-persisted state. Survives /reload of the same session;
  // /new and /fork start fresh session files so defaults apply.
  pi.on("session_start", async (_event, ctx) => {
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "custom") continue;
        if (entry.customType === LOCK_KEY) {
          const data = entry.data as LockState | undefined;
          if (data && typeof data.locked === "boolean") {
            locked = data.locked;
          }
        } else if (entry.customType === DEBUG_KEY) {
          const data = entry.data as DebugState | undefined;
          if (data && typeof data.debug === "boolean") {
            debug = data.debug;
          }
        }
      }
    } catch (e) {
      log("[session_start] failed to read entries: " + e);
    }
    log("\n=== model-lock loaded " + new Date().toISOString() + " (locked=" + locked + ", debug=" + debug + ") ===");
    if (debug) {
      try {
        const s = readSettings();
        log("[session_start] settings default: " + s.defaultProvider + "/" + s.defaultModel);
      } catch (e) {
        log("[session_start] settings read FAIL: " + e);
      }
      try {
        log("[session_start] entries: " + ctx.sessionManager.getEntries().length);
      } catch {}
    }
  });

  function saveLocked(): void {
    pi.appendEntry<LockState>(LOCK_KEY, { locked });
  }

  function saveDebug(): void {
    pi.appendEntry<DebugState>(DEBUG_KEY, { debug });
  }

  function runAction(action: "on" | "off" | "status", notify: (msg: string, level: "info" | "warning") => void) {
    if (action === "status") {
      const state = locked
        ? "ON — /model changes only affect the current session; your global default in settings.json is preserved."
        : "OFF — /model switches persist to settings.json and become the default for new sessions (pi's built-in behavior).";
      notify("model-lock [status] " + state + logHint(), "info");
      log("[/model-lock status] locked=" + locked);
      return;
    }
    if (action === "on") {
      locked = true;
      saveLocked();
      notify("model-lock [on] enabled — /model changes the current session only; your default in settings.json is preserved.", "info");
      log("[/model-lock on] locked now true");
      return;
    }
    locked = false;
    saveLocked();
    notify("model-lock [off] disabled — /model will now persist to settings.json as pi's default behavior.", "info");
    log("[/model-lock off] locked now false");
  }

  // /model-lock debug handler. No arg = toggle; on/off explicit.
  function runDebug(sub: string | undefined, notify: (msg: string, level: "info" | "warning") => void, via: string) {
    const s = (sub || "").trim().toLowerCase();
    let next: boolean;
    if (!s || s === "toggle" || s === "t") {
      next = !debug;
    } else if (s === "on" || s === "true" || s === "1") {
      next = true;
    } else if (s.startsWith("of") || s === "false" || s === "0") {
      next = false;
    } else {
      notify("Usage: /model-lock debug [on|off] (no arg toggles)", "warning");
      return;
    }
    debug = next;
    saveDebug();
    notify("model-lock [debug] " + (next ? "ON" : "OFF") + logHint(), "info");
    log("[/" + via + " debug] debug now " + next);
  }

  // Unified dispatch for on|off|status|debug subcommands.
  function dispatch(raw: string | undefined, notify: (msg: string, level: "info" | "warning") => void, via: string) {
    const parts = (raw || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (parts[0] === "debug") {
      runDebug(parts.slice(1).join(" "), notify, via);
      return;
    }
    const action = parseArgs(raw);
    if (!action) {
      notify("Usage: /model-lock on|off|status", "warning");
      return;
    }
    runAction(action, notify);
  }

  pi.registerCommand("model-lock", {
    description: "Lock default model — /model won't change settings.json default. Args: on|off|status",
    handler: async (args, ctx) => {
      dispatch(args, (m, l) => ctx.ui.notify(m, l), "model-lock");
    },
  });

  // /model-save — persist the CURRENT session model (agent.state.model) as
  // the new global default in settings.json, without changing the lock state.
  // Use case: you've switched to glm-4.6 for this session, like it, want it as
  // the default for new sessions — but you don't want to toggle the lock off
  // (which would leave ALL future /model switches persisting until you
  // toggle back). This writes once, leaves lock ON.
  pi.registerCommand("model-save", {
    description: "Persist the current session model as the new global default (one-time write, lock state unchanged)",
    handler: async (_args, ctx) => {
      const cur = ctx.model;
      const id = cur?.id;
      const provider = cur?.provider;
      if (!id || !provider) {
        ctx.ui.notify("No current model to save.", "warning");
        return;
      }
      const s = readSettings();
      const prev = s.defaultProvider + "/" + s.defaultModel;
      s.defaultModel = id;
      s.defaultProvider = provider;
      writeSettings(s);
      ctx.ui.notify("model saved — default now " + provider + "/" + id + " (was " + prev + "). Lock still " + (locked ? "ON" : "OFF") + ".", "info");
      log("[/model-save] " + prev + " -> " + provider + "/" + id + " (locked=" + locked + ")");
    },
  });

  // Catch unhyphenated /modellock (with any subcommand) and /modelsave
  // without registering them as commands — keeps them out of the slash menu.
  // Returns {action:"handled"} so the agent never sees them.
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return undefined;
    const text = event.text;

    // /modellock alias (covers on|off|status|debug)
    if (text === "/modellock" || text.startsWith("/modellock ")) {
      const argStr = text.slice("/modellock".length).trim();
      dispatch(argStr || undefined, (m, l) => ctx.ui.notify(m, l), "modellock");
      return { action: "handled" };
    }

    // /modelsave alias — run the save logic inline
    if (text === "/modelsave" || text === "/modelsave ") {
      const cur = ctx.model;
      const id = cur?.id;
      const provider = cur?.provider;
      if (!id || !provider) {
        ctx.ui.notify("No current model to save.", "warning");
        return { action: "handled" };
      }
      const s = readSettings();
      const prev = s.defaultProvider + "/" + s.defaultModel;
      s.defaultModel = id;
      s.defaultProvider = provider;
      writeSettings(s);
      ctx.ui.notify("model saved — default now " + provider + "/" + id + " (was " + prev + "). Lock still " + (locked ? "ON" : "OFF") + ".", "info");
      log("[/modelsave] " + prev + " -> " + provider + "/" + id + " (locked=" + locked + ")");
      return { action: "handled" };
    }

    return undefined;
  });

  // === RESTORE LOGIC — verbatim from v3 (proven working) ===
  // Only addition: logging moved ABOVE the `locked` check so we always see
  // model_select events regardless of lock state. The restore block itself
  // is unchanged.
  pi.on("model_select", async (event: any, ctx: any) => {
    // Log FIRST, before any early return, so we always see model_select events
    // regardless of lock state.
    log("\n[model_select " + new Date().toISOString() + "]");
    log("  event.model:   " + event?.model?.provider + "/" + event?.model?.id);
    log("  source:        " + String(event?.source));
    log("  locked:        " + locked);

    // Surface state in the TUI so the user sees lock status after a /model
    // switch. Deferred slightly so pi's own model-switch display ("Model: ...")
    // renders first and doesn't clobber our notify. Log hint only when debug.
    const switchedTo = event?.model?.id || "?";
    setTimeout(() => {
      try {
        ctx?.ui?.notify("Model: " + switchedTo + " — lock " + (locked ? "ON" : "OFF") + logHint(), "info");
      } catch {}
    }, 200);

    // log("  event dump:   " + JSON.stringify(event, null, 2).replace(/\n/g, "\n                "));
    log("  file at entry: " + (() => { try { const s = readSettings(); return s.defaultProvider + "/" + s.defaultModel; } catch (e) { return "READ FAIL: " + e; } })());

    if (event?.source === "restore") {
      log("  SKIP: session restore source");
      return;  // session restore, legit
    }

    const oldFile = readSettings();
    const oldModel = oldFile.defaultModel;
    const oldProvider = oldFile.defaultProvider;
    const newModel = event?.model?.id;

    log("  oldFile model: " + oldProvider + "/" + oldModel);

    // Wait for pi's write to land (file shows new model).
    // Same poll for both ON and OFF — we always observe.
    let landed = false;
    let pollIters = 0;
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) {
      pollIters = i + 1;
      const s = readSettings();
      if (debug) {
        log("    poll[" + i + "] file=" + s.defaultProvider + "/" + s.defaultModel + " target=" + newModel);
      }
      if (s.defaultModel === newModel) { landed = true; break; }
      await sleep(10);
    }
    log("  file post-poll: " + (() => { try { const s = readSettings(); return s.defaultProvider + "/" + s.defaultModel; } catch (e) { return "READ FAIL: " + e; } })());
    log("  pi write landed: " + landed + " (iters=" + pollIters + " ms=" + (Date.now() - t0) + ")");

    if (locked) {
      // ON: restore old file values
      const s = readSettings();
      s.defaultModel = oldModel;
      s.defaultProvider = oldProvider;
      try {
        writeSettings(s);
      } catch (e) {
        log("  RESTORE WRITE FAIL: " + e);
        throw e;
      }
      log("  restored to:    " + s.defaultProvider + "/" + s.defaultModel);
      if (debug) {
        try {
          const chk = readSettings();
          log("  verify readback: " + chk.defaultProvider + "/" + chk.defaultModel + (chk.defaultModel === oldModel ? " OK" : " MISMATCH"));
        } catch (e) { log("  verify readback FAIL: " + e); }
      }
    } else {
      // OFF: just log what pi left in the file
      const s = readSettings();
      log("  LOCK OFF — left as: " + s.defaultProvider + "/" + s.defaultModel);
    }
  });
}
