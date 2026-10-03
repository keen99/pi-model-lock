import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// PI_CODING_AGENT_DIR must point at a sandbox before importing the extension:
// settings paths resolve through getAgentDir() per call, but the module-level
// DATA_DIR only moves with the env var set early.
const agentDir = mkdtempSync(join(tmpdir(), "model-lock-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const SETTINGS = join(agentDir, "settings.json");

const { default: modelLock } = await import("../index.js");

type Entry = { type: string; customType?: string; data?: unknown };
type Ctx = any;

function harness(settings: Record<string, unknown>, branch: Entry[] = []) {
	writeFileSync(SETTINGS, JSON.stringify(settings));
	const notices: Array<{ text: string; level: string }> = [];
	const entries = [...branch];
	const commands = new Map<string, { description: string; handler: (args: string, ctx: Ctx) => Promise<void> }>();
	const inputHandlers: Array<(event: { text: string; source?: string }, ctx: Ctx) => Promise<unknown>> = [];
	const modelSelectHandlers: Array<(event: { model?: { id?: string; provider?: string }; source?: string }, ctx: Ctx) => Promise<void>> = [];
	const startHandlers: Array<(event: unknown, ctx: Ctx) => Promise<void>> = [];
	const ctx: Ctx = {
		model: { id: "glm-5.3-flash", provider: "zai" },
		ui: { notify: (text: string, level = "info") => notices.push({ text, level }) },
		sessionManager: { getEntries: () => entries, getBranch: () => entries },
	};
	const pi: any = {
		appendEntry: (customType: string, data: unknown) =>
			entries.push({ type: "custom", customType, data }),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (event: string, handler: never) => {
			if (event === "session_start") startHandlers.push(handler);
			else if (event === "input") inputHandlers.push(handler);
			else if (event === "model_select") modelSelectHandlers.push(handler);
		},
	};
	modelLock(pi);
	return {
		notices,
		entries,
		commands,
		start: () => Promise.all(startHandlers.map((h) => h({}, ctx))),
		command: (name: string, args: string) => commands.get(name)!.handler(args, ctx),
		input: (text: string, source?: string) =>
			Promise.all(inputHandlers.map((h) => h({ text, source }, ctx))),
		select: (model: { id: string; provider: string }, source?: string) =>
			Promise.all(modelSelectHandlers.map((h) => h({ model, source }, ctx))),
	};
}
const settings = () => JSON.parse(readFileSync(SETTINGS, "utf-8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("commands registered with expected surface", async () => {
	const app = harness({ defaultProvider: "zai", defaultModel: "glm-5.3-flash" });
	assert.deepEqual([...app.commands.keys()].sort(), ["model-lock", "model-save"]);
});

test("status/on/off toggle lock state via session entries only", async () => {
	const app = harness({ defaultProvider: "zai", defaultModel: "glm-5.3-flash" });
	await app.command("model-lock", "status");
	assert.match(app.notices.at(-1)!.text, /ON /);
	await app.command("model-lock", "off");
	await app.command("model-lock", "status");
	assert.match(app.notices.at(-1)!.text, /OFF /);
	assert.deepEqual(app.entries, [
		{ type: "custom", customType: "model-lock-locked", data: { locked: false } },
	]);
	const before = readFileSync(SETTINGS, "utf-8");
	await app.command("model-lock", "on");
	assert.equal(readFileSync(SETTINGS, "utf-8"), before, "toggles never write settings");
});

test("session_start restores persisted lock and debug state", async () => {
	const app = harness(
		{ defaultProvider: "zai", defaultModel: "glm-5.3-flash" },
		[
			{ type: "custom", customType: "model-lock-locked", data: { locked: false } },
			{ type: "custom", customType: "model-lock-debug", data: { debug: true } },
		],
	);
	await app.start();
	await app.command("model-lock", "status");
	assert.match(app.notices.at(-1)!.text, /OFF /);
});

test("model_select with lock ON restores settings default (simulated pi write)", async () => {
	const app = harness({ defaultProvider: "zai", defaultModel: "glm-5.3-flash" });
	await app.command("model-lock", "on");
	// Simulate pi writing the new model while the handler polls for it.
	setTimeout(() => writeFileSync(SETTINGS, JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-6.1" })), 20);
	await app.select({ id: "gpt-6.1", provider: "openai" });
	await sleep(10);
	const s = settings();
	assert.equal(s.defaultModel, "glm-5.3-flash");
	assert.equal(s.defaultProvider, "zai");
});

test("model_select with lock OFF leaves the pi-persisted default alone", async () => {
	const app = harness({ defaultProvider: "zai", defaultModel: "glm-5.3-flash" });
	await app.command("model-lock", "off");
	setTimeout(() => writeFileSync(SETTINGS, JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-6.1" })), 20);
	await app.select({ id: "gpt-6.1", provider: "openai" });
	await sleep(10);
	assert.equal(settings().defaultModel, "gpt-6.1");
});

test("model_select with source=restore never touches settings", async () => {
	const before = JSON.stringify({ defaultProvider: "zai", defaultModel: "glm-5.3-flash" });
	const app = harness(JSON.parse(before));
	await app.command("model-lock", "off");
	await app.select({ id: "gpt-6.1", provider: "openai" }, "restore");
	await sleep(10);
	assert.equal(readFileSync(SETTINGS, "utf-8"), before);
});

test("/model-save persists current session model once; lock state unchanged", async () => {
	const app = harness({ defaultProvider: "zai", defaultModel: "glm-5.3-flash" });
	await app.command("model-lock", "on");
	await app.command("model-save", "");
	const s = settings();
	assert.equal(s.defaultModel, "glm-5.3-flash");
	assert.equal(s.defaultProvider, "zai");
	assert.match(app.notices.at(-1)!.text, /Lock still ON/);
	assert.deepEqual(
		app.entries.filter((e) => e.customType === "model-lock-locked"),
		[{ type: "custom", customType: "model-lock-locked", data: { locked: true } }],
	);
});

test("input aliases handle /modellock and /modelsave silently", async () => {
	const app = harness({ defaultProvider: "zai", defaultModel: "glm-5.3-flash" });
	await app.input("/modellock status");
	assert.match(app.notices.at(-1)!.text, /model-lock \[status\]/);
	await app.input("/modelsave");
	assert.equal(settings().defaultModel, "glm-5.3-flash");
	const handled = await app.input("/modellock off");
	assert.ok(handled.every((r: any) => r?.action === "handled"));
});

test("debug subcommand toggles per-session and usage error on garbage", async () => {
	const app = harness({ defaultProvider: "zai", defaultModel: "glm-5.3-flash" });
	await app.command("model-lock", "debug");
	assert.match(app.notices.at(-1)!.text, /debug\] ON/);
	await app.command("model-lock", "debug off");
	assert.match(app.notices.at(-1)!.text, /debug\] OFF/);
	await app.command("model-lock", "wat");
	assert.match(app.notices.at(-1)!.text, /Usage:/);
});

test("cleanup", () => rmSync(agentDir, { recursive: true, force: true }));
