import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

// Run in a fresh process with an isolated PI_CODING_AGENT_DIR before importing Intercom.
const require = createRequire(import.meta.url);
const sdk = await import(process.env.PI_SCHEDULE_HOST_ENTRY || '@earendil-works/pi-coding-agent');
const ai = await import('@earendil-works/pi-ai');
const { default: intercom } = await import('pi-intercom/index.ts');
const { IntercomClient } = await import('pi-intercom/broker/client.ts');
const { default: schedule } = await import(process.env.PI_SCHEDULE_EXTENSION_ENTRY || '../src/index.ts');
const { CronStorage } = await import('../src/storage.ts');
const root = process.env.PI_SCHEDULE_FIXTURE_CASE;
assert(root && process.env.PI_CODING_AGENT_DIR?.startsWith(root));
const agentDir = process.env.PI_CODING_AGENT_DIR;
const intercomRoot = path.dirname(require.resolve('pi-intercom/package.json'));
const broker = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, path.join(intercomRoot, 'broker/broker.ts')], {
  cwd: root, env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
process.once("SIGTERM", () => { broker.kill("SIGTERM"); process.exitCode = 143; });
let stderr = '';
broker.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
const sessions = [];
const faults = [];
async function until(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('Fixture condition timed out: ' + stderr);
}
async function makeSession(name, cwd, responses, extensions, tools, manager) {
  fs.mkdirSync(cwd, { recursive: true });
  const faux = ai.fauxProvider({ provider: 'online-fixture-' + name });
  faux.setResponses(responses);
  const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsStore: new ai.InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const settings = sdk.SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: extensions });
  await loader.reload();
  const { session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: 'off', tools, settingsManager: settings, sessionManager: manager || sdk.SessionManager.inMemory(cwd), resourceLoader: loader });
  sessions.push(session);
  await session.bindExtensions({ mode: 'rpc', onError: error => { faults.push(error.message); } });
  return { session, faux };
}
const observer = new IntercomClient();
try {
  await until(() => fs.existsSync(path.join(agentDir, 'intercom/broker.sock')));
  await observer.connect({ cwd: root, model: 'fixture', pid: process.pid, startedAt: Date.now(), lastActivity: Date.now(), name: 'fixture-observer', status: 'idle' }, 'fixture-observer');
  if (process.env.PI_SCHEDULE_SCENARIO === "offline") {
    const cwd = path.join(root, "supervisor");
    fs.mkdirSync(cwd);
    const manager = sdk.SessionManager.inMemory(cwd);
    const storage = new CronStorage(cwd);
    storage.addJob({ id: "offline", name: "offline", type: "once", schedule: new Date(Date.now() + 500).toISOString(), prompt: "Check only the named synthetic offline peer; do not create a replacement.", enabled: true, createdAt: new Date().toISOString(), runCount: 0, session: manager.getSessionId() });
    const responses = [
      ai.fauxAssistantMessage(ai.fauxToolCall("intercom", { action: "ask", to: "fixture-missing-session", message: "Synthetic authorized status check" })),
      context => {
        assert(context.messages.some(message => message.role === "toolResult" && JSON.stringify(message).includes("not currently connected")));
        return ai.fauxAssistantMessage("Offline target; blocked, no replacement requested.");
      },
    ];
    const parent = await makeSession("offline-supervisor", cwd, responses, [intercom, schedule], ["intercom", "schedule_prompt"], manager);
    await until(() => parent.session.getLastAssistantText() === "Offline target; blocked, no replacement requested.");
    assert.equal(parent.faux.state.callCount, 2);
    assert.equal(storage.getJob("offline").enabled, false);
    assert.equal(sessions.length, 1);
    assert.deepEqual(faults, []);
    console.log(JSON.stringify({ ok: true, scenario: "offline", realBroker: true, nativePiSessions: 1, offlineDetected: true, replacementCreated: false, realProviderCalls: 0, businessSessionsTouched: 0 }));
  } else {
  const parentCwd = path.join(root, 'supervisor');
  fs.mkdirSync(parentCwd);
  const manager = sdk.SessionManager.inMemory(parentCwd);
  const parentId = manager.getSessionId();
  const evidenceA = path.join(root, 'a/result.json');
  const evidenceB = path.join(root, 'b/result.json');
  const worker = label => [
    ai.fauxAssistantMessage(ai.fauxToolCall('write', { path: 'result.json', content: JSON.stringify({ goal: label, answer: label === 'a' ? 4 : 9 }) })),
    ai.fauxAssistantMessage(ai.fauxToolCall('intercom', { action: 'send', to: parentId, message: 'Fixture ' + label + ' produced result.json; verify it, not this claim.', wake: false })),
    ai.fauxAssistantMessage('Fixture work finished.'),
  ];
  const a = await makeSession('a', path.join(root, 'a'), worker('a'), [intercom], ['write', 'intercom']);
  const b = await makeSession('b', path.join(root, 'b'), worker('b'), [intercom], ['write', 'intercom']);
  await until(async () => { const list = await observer.listSessions(); return list.some(x => x.id === a.session.sessionId) && list.some(x => x.id === b.session.sessionId); });
  const storage = new CronStorage(parentCwd);
  storage.addJob({ id: 'fixture-supervision', name: 'fixture-supervision', type: 'interval', schedule: '1s', intervalMs: 1000, prompt: 'Advance the two explicitly authorized fixture goals; verify result files and stop the known schedule when both pass.', enabled: true, createdAt: new Date().toISOString(), runCount: 0, maxRuns: 4, expiresAt: new Date(Date.now() + 20000).toISOString(), session: parentId });
  const supervisorResponses = [
    ai.fauxAssistantMessage([
      ai.fauxToolCall('intercom', { action: 'send', to: a.session.sessionId, message: 'Authorized fixture a: produce result.json with answer 4. No other changes.', wake: true }),
      ai.fauxToolCall('intercom', { action: 'send', to: b.session.sessionId, message: 'Authorized fixture b: produce result.json with answer 9. No other changes.', wake: true }),
    ]),
    async () => { await until(() => fs.existsSync(evidenceA) && fs.existsSync(evidenceB)); return ai.fauxAssistantMessage('Waiting for the next bounded verification check.'); },
    ai.fauxAssistantMessage([ai.fauxToolCall('read', { path: evidenceA }), ai.fauxToolCall('read', { path: evidenceB })]),
    ai.fauxAssistantMessage(ai.fauxToolCall('schedule_prompt', { action: 'disable', jobId: 'fixture-supervision' })),
    ai.fauxAssistantMessage('Both fixture results verified; future checks stopped.'),
  ];
  const parent = await makeSession('supervisor', parentCwd, supervisorResponses, [intercom, schedule], ['intercom', 'schedule_prompt', 'read'], manager);
  await until(() => storage.getJob('fixture-supervision')?.enabled === false);
  await until(() => parent.session.getLastAssistantText() === 'Both fixture results verified; future checks stopped.');
  assert.deepEqual(JSON.parse(fs.readFileSync(evidenceA, 'utf8')), { goal: 'a', answer: 4 });
  assert.deepEqual(JSON.parse(fs.readFileSync(evidenceB, 'utf8')), { goal: 'b', answer: 9 });
  assert.equal(storage.getJob('fixture-supervision').runCount, 2);
  assert.equal(a.faux.state.callCount, 3);
  assert.equal(b.faux.state.callCount, 3);
  assert.equal(parent.faux.state.callCount, 5);
  assert.deepEqual(faults, []);
  const count = parent.faux.state.callCount;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(parent.faux.state.callCount, count);
  console.log(JSON.stringify({ ok: true, scenario: "online", realBroker: true, nativePiSessions: 3, peerGoalsVerified: 2, supervisorChecks: 2, stopped: true, realProviderCalls: 0, businessSessionsTouched: 0 }));
  }
} finally {
  for (const session of sessions.reverse()) {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
  }
  await observer.disconnect().catch(() => {});
  const exited = new Promise(resolve => broker.once('exit', resolve));
  broker.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1500))]);
  if (broker.exitCode === null && broker.signalCode === null) broker.kill('SIGKILL');
}
