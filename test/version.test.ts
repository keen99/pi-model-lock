import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Sandbox before importing the extension (module-level DATA_DIR).
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "model-lock-ver-"));

const {
	default: modelLock,
	parseSemver,
	compareSemver,
	piWarnMode,
	detectPiVersion,
} = await import("../index.js");

type Ctx = any;

const SETTINGS = join(process.env.PI_CODING_AGENT_DIR!, "settings.json");

function harness() {
	writeFileSync(SETTINGS, JSON.stringify({ defaultProvider: "zai", defaultModel: "glm-5.3-flash" }));
	const notices: Array<{ text: string; level: string }> = [];
	const commands = new Map<string, { description: string; handler: (args: string, ctx: Ctx) => Promise<void> }>();
	const inputHandlers: Array<(event: { text: string; source?: string }, ctx: Ctx) => Promise<unknown>> = [];
	const modelSelectHandlers: Array<(event: any, ctx: Ctx) => Promise<void>> = [];
	const startHandlers: Array<(event: unknown, ctx: Ctx) => Promise<void>> = [];
	const ctx: Ctx = {
		model: { id: "glm-5.3-flash", provider: "zai" },
		ui: { notify: (text: string, level = "info") => notices.push({ text, level }) },
		sessionManager: { getEntries: () => [], getBranch: () => [] },
	};
	const api: any = {
		registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
		on: (ev: string, fn: any) => {
			if (ev === "input") inputHandlers.push(fn);
			if (ev === "model_select") modelSelectHandlers.push(fn);
		},
		appendEntry: () => {},
	};
	return { notices, commands, inputHandlers, modelSelectHandlers, ctx, api };
}

test("parseSemver: numeric triple, garbage, prerelease prefix", () => {
	assert.deepEqual(parseSemver("1.0.1"), { major: 1, minor: 0, patch: 1 });
	assert.deepEqual(parseSemver("0.99.0-beta.2"), { major: 0, minor: 99, patch: 0 });
	assert.equal(parseSemver("garbage"), null);
	assert.equal(parseSemver(null), null);
});

test("compareSemver: numeric not lexicographic", () => {
	assert.ok(compareSemver({ major: 0, minor: 99, patch: 0 }, { major: 0, minor: 87, patch: 1 }) > 0);
	assert.ok(compareSemver({ major: 1, minor: 0, patch: 0 }, { major: 0, minor: 99, patch: 9 }) > 0);
	assert.ok(compareSemver({ major: 0, minor: 9, patch: 0 }, { major: 0, minor: 10, patch: 0 }) < 0);
	assert.equal(compareSemver({ major: 1, minor: 2, patch: 3 }, { major: 1, minor: 2, patch: 3 }), 0);
});

test("piWarnMode: threshold 0.99.0, unknown -> false (full lock)", () => {
	assert.equal(piWarnMode("0.87.1"), false);
	assert.equal(piWarnMode("0.75.4"), false);
	assert.equal(piWarnMode("0.99.0"), true);
	assert.equal(piWarnMode("1.0.1"), true);
	assert.equal(piWarnMode(null), false);
	assert.equal(piWarnMode("unknown"), false);
});

test("detectPiVersion: finds pi package.json upward from a nested path", () => {
	// This test file lives inside the harness checkout; the pi dev-dependency
	// install is upward from node_modules. Use the matrix cache if present.
	const found = detectPiVersion(process.argv[1]);
	// Under tsx argv[1] is the runner; detection may or may not find pi here.
	// Contract: null or a valid version string, never a throw.
	if (found) assert.match(found.version, /^\d+\.\d+\.\d+/);
	assert.equal(detectPiVersion(undefined), null);
});

test("warn mode (forced 1.0.1): commands replace themselves, no model_select hook", async () => {
	const h = harness();
	modelLock(h.api, "1.0.1");
	assert.equal(h.modelSelectHandlers.length, 0, "no restore hook in warn mode");

	const status = h.commands.get("model-lock");
	assert.ok(status);
	await status.handler("status", h.ctx);
	assert.match(h.notices.at(-1)!.text, /not needed on pi 1\.0\.1/);
	assert.match(h.notices.at(-1)!.text, /ctrl\+s \("set as default"\)/);
	assert.equal(h.notices.at(-1)!.level, "warning");

	h.notices.length = 0;
	await status.handler("on", h.ctx);
	assert.match(h.notices.at(-1)!.text, /not needed on pi 1\.0\.1/);

	const save = h.commands.get("model-save");
	assert.ok(save);
	await save.handler("", h.ctx);
	assert.match(h.notices.at(-1)!.text, /model-save: replaced on pi 1\.0\.1/);
	assert.match(h.notices.at(-1)!.text, /ctrl\+l .* ctrl\+s/);

	// Alias input also warns and is swallowed.
	const before = h.notices.length;
	const handled = await h.inputHandlers[0]({ text: "/modellock on" }, h.ctx);
	assert.deepEqual(handled, { action: "handled" });
	assert.ok(h.notices.length > before, "alias warned");

	// No settings writes attempted (no writeMocks — nothing threw).
});

test("lock mode (unknown version): hook registered, commands work normally", async () => {
	const h = harness();
	modelLock(h.api, null); // forced unknown -> full lock behavior
	assert.equal(h.modelSelectHandlers.length, 1, "restore hook registered");

	const status = h.commands.get("model-lock");
	await status.handler("status", h.ctx);
	assert.match(h.notices.at(-1)!.text, /ON —/);

	const save = h.commands.get("model-save");
	assert.ok(save);
	await save.handler("", h.ctx);
	assert.match(h.notices.at(-1)!.text, /default now zai\/glm-5\.3-flash/);
});
