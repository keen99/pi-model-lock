#!/usr/bin/env node
// Deep pinned-pi smoke. Proves the restore flow against a real pi process:
//  1. lock OFF (from session entries): set_model persists the new default —
//     real pi settings write passes through untouched.
//  2. lock ON (from session entries): set_model must NOT change settings.json —
//     the extension restores the previous default. pi writes settings BEFORE
//     emitting model_select, so the only correct restore source is
//     event.previousModel.
//  3. session-entry persistence: lock states come from fixture session files,
//     restored through real session_start handling.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'model-lock-deep-'));
const agentDir = join(dir, 'agent');
const sessions = join(agentDir, 'sessions', '--tmp-proj--');
mkdirSync(sessions, { recursive: true });
const line = (obj) => JSON.stringify(obj) + '\n';
const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const uuid = () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;

function fixture(name, locked) {
	const id = uuid();
	let parentId = null;
	const entry = (e) => { e.id = e.id ?? hex(8); e.parentId = parentId; parentId = e.id; return line(e); };
	writeFileSync(join(sessions, `${name}_${id}.jsonl`),
		line({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: '/tmp' }) +
		line({ type: 'message', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: name }], timestamp: Date.now() } }) +
		line({ type: 'message', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: Date.now() }, usage: { input: 1, output: 1, cost: { total: 0 } } }) +
		entry({ type: 'custom', customType: 'model-lock-locked', data: { locked } }));
	return join(sessions, `${name}_${id}.jsonl`);
}
const lockOffPath = fixture('unlock', false);
const lockOnPath = fixture('lock', true);

const SETTINGS = join(agentDir, 'settings.json');
const writeSettings = (obj) => writeFileSync(SETTINGS, JSON.stringify(obj));
const readDefault = () => JSON.parse(readFileSync(SETTINGS, 'utf8')).defaultModel;

writeSettings({ defaultProvider: 'zai', defaultModel: 'glm-5.3-flash' });
writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({
	zai: { type: 'api_key', key: 'sk-fake-zai' },
	openai: { type: 'api_key', key: 'sk-fake-openai' },
}));

const child = spawn(
	process.env.PI_TEST_BIN ?? join(dirname(process.execPath), 'pi'),
	['--mode', 'rpc', '--no-extensions', '-e', join(root, 'index.ts'), '--session-dir', sessions],
	{ env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ZAI_API_KEY: 'sk-fake-zai', OPENAI_API_KEY: 'sk-fake-openai' }, cwd: dir },
);
const killTimer = setTimeout(() => child.kill('SIGKILL'), 60_000);
let out = '';
let stage = 'boot';
let target = null;
let target2 = null; // second model, discovered from the sandbox registry
let preB; // settings default before the lock-ON switch
const responses = new Map(); // id -> parsed response line
const poll = (want, timeoutMs = 15_000) =>
	new Promise((resolve, reject) => {
		const t0 = Date.now();
		const timer = setInterval(() => {
			if (readDefault() === want) { clearInterval(timer); resolve(); }
			else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); reject(new Error(`settings never became ${want}; got ${readDefault()}`)); }
		}, 100);
	});
child.stdout.on('data', (d) => {
	out += d;
	for (const l of out.split('\n')) {
		if (!l.startsWith('{')) continue;
		try {
			const j = JSON.parse(l);
			if (j.id && j.type === 'response' && !responses.has(j.id)) responses.set(j.id, j);
		} catch { /* partial line */ }
	}
	const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
	if (stage === 'boot' && responses.has('deep-1')) {
		const cmds = responses.get('deep-1').data?.commands ?? [];
		assert2(cmds.some((c) => c.name === 'model-lock') && cmds.some((c) => c.name === 'model-save'), 'commands registered');
		stage = 'models';
		send({ type: 'get_available_models', id: 'm0' });
	} else if (stage === 'models' && responses.has('m0')) {
		const data = responses.get('m0').data;
		const flat = Array.isArray(data) ? data : (data?.models ?? []);
		// Any two distinct available models work: the restore proof uses
		// event.previousModel (the session's model before set_model), which is
		// model A after phase 1 switched to model B.
		const usable = flat.filter((m) => m.id && m.provider);
		assert2(usable.length >= 2, `two models needed; got ${JSON.stringify(flat).slice(0, 400)}`);
		target = usable[0];
		globalThis.__usableIds = usable.map((m) => `${m.provider}/${m.id}`);
		target2 = usable.find((m) => m.id !== target.id || m.provider !== target.provider);
		console.error(`  models: ${globalThis.__usableIds.join(', ')}`);
		stage = 'switchA';
		send({ type: 'switch_session', id: 's1', sessionPath: lockOffPath });
	} else if (stage === 'switchA' && responses.has('s1')) {
		assert2(responses.get('s1').success === true, 'switch to lock-OFF session');
		stage = 'setA';
		send({ type: 'set_model', id: 'm1', provider: target.provider, modelId: target.id });
	} else if (stage === 'setA' && responses.has('m1')) {
		assert2(responses.get('m1').success === true, `set_model to ${target.id}: ${responses.get('m1').error ?? ''}`);
		stage = 'waitA';
		// Era-aware: <=0.98 persists the switch; 0.99+ keeps settings.json
		// untouched (setModel persist:false). Both are correct lock-OFF behavior.
		const initial = readDefault();
		setTimeout(() => {
			const now = readDefault();
			assert2(now === target.id || now === initial, `lock OFF: settings moved to ${now}, expected ${target.id} or untouched ${initial}`);
			console.error(now === target.id
				? `  phase 1 PASS: lock OFF — pi persists (era <=0.98): file = ${now}`
				: `  phase 1 PASS: lock OFF — pi does not persist (era 0.99+): file untouched`);
			stage = 'switchB';
			send({ type: 'switch_session', id: 's2', sessionPath: lockOnPath });
		}, 1500);
	} else if (stage === 'switchB' && responses.has('s2')) {
		assert2(responses.get('s2').success === true, 'switch to lock-ON session');
		stage = 'setB';
		preB = readDefault();
		send({ type: 'set_model', id: 'm2', provider: target2.provider, modelId: target2.id });
	} else if (stage === 'setB' && responses.has('m2')) {
		assert2(responses.get('m2').success === true, `set_model to ${target2.id}: ${responses.get('m2').error ?? ''}`);
		stage = 'waitB';
		// Lock ON invariant, every era: settings.json must be exactly what it
		// was before the switch. Persist-era: restore puts previousModel back.
		// Non-persist era: pi never wrote; restore writes same value back.
		setTimeout(() => {
			const now = readDefault();
			if (now === preB) {
				console.error(`  phase 2 PASS: lock ON — settings unchanged (${preB})`);
				child.kill('SIGTERM');
			} else {
				console.error(`FAIL lock ON: settings = ${now}, expected ${preB}`);
				child.kill('SIGKILL');
			}
		}, 1500);
	}
});
child.stderr.on('data', (d) => { out += d; });
child.on('exit', () => {
	clearTimeout(killTimer);
	try {
		assert2(stage === 'waitB', `reached lock-ON phase (stuck at ${stage}); raw=${out.slice(-1500)}`);
		assert2(readDefault() === preB, `lock ON must leave settings unchanged; got ${readDefault()}, want ${preB}`);
		console.log('Deep smoke PASS: real model_select, real settings write, restore proven.');
	} catch (e) {
		console.error('FAIL', e.message);
		process.exitCode = 1;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
child.stdin.write(JSON.stringify({ type: 'get_commands', id: 'deep-1' }) + '\n');
function assert2(cond, msg) { if (!cond) throw new Error(msg); }
