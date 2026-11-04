// Provider-free packed/native acceptance. Run only against an explicit unpacked Schedule candidate
// and a Pi candidate whose v1 native capability is loaded. No global install, real provider or live store.
// node test/resilient-native.mjs <unpacked-package-root> <owned-output-root>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = path.resolve(process.argv[2] || '');
const output = path.resolve(process.argv[3] || 'tmp/resilient-native');
assert(fs.existsSync(path.join(packageRoot, 'dist/index.js')) || fs.existsSync(path.join(packageRoot, 'dist/scheduler.js')), 'Explicit unpacked Schedule candidate is required');
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(output, 'case-'));
const home = path.join(root, 'home'); const agentDir = path.join(root, 'agent');
fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(agentDir, { mode: 0o700 });
process.env.HOME = home; process.env.PI_CODING_AGENT_DIR = agentDir;
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ packages: [], compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } }), { mode: 0o600 });
// Pi's packages are ESM-only. Resolve their documented dist/index.js import entries in this fixture,
// rather than using CJS require.resolve (which cannot satisfy an import-only exports condition).
const sdk = await import(pathToFileURL(path.join(packageRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
const ai = await import(pathToFileURL(path.join(packageRoot, 'node_modules/@earendil-works/pi-ai/dist/index.js')).href);
const schedule = (await import(pathToFileURL(path.join(packageRoot, 'dist/index.js')).href)).default;
const { CronStorage } = await import(pathToFileURL(path.join(packageRoot, 'dist/storage.js')).href);
const { resilientDefinition } = await import(pathToFileURL(path.join(packageRoot, 'dist/resilient-policy.js')).href);
const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));
async function until(predicate, label, timeout = 120_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await sleep(25); }
  throw new Error('Bounded native fixture deadline: ' + label);
}
const overload = () => ai.fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503 synthetic server overloaded' });

async function nativeCase(mode) {
  const cwd = path.join(root, mode); fs.mkdirSync(path.join(cwd, '.pi', 'extensions'), { recursive: true, mode: 0o700 });
  const artifact = path.join(cwd, 'saved-result.txt'); const saved = 'NATIVE_SAVED_RESULT_' + mode;
  fs.writeFileSync(artifact, saved, { mode: 0o600 });
  const nextAction = 'USE_THE_EXACT_SAVED_NATIVE_RESULT_' + mode;
  fs.writeFileSync(path.join(cwd, '.pi', 'extensions', 'checkpoint-declaration.mjs'), `export default (pi) => { pi.on('before_agent_start', (_event, ctx) => { ctx.scheduledExecution?.active?.checkpoint({ nextAction: ${JSON.stringify(nextAction)}, artifacts: [{ ref: ${JSON.stringify(artifact)}, sha256: ${JSON.stringify(createHash('sha256').update(saved).digest('hex'))} }] }); }); };\n`, { mode: 0o600 });
  const faux = ai.fauxProvider({ provider: 'resilient-native-' + mode });
  const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsStore: new ai.InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const manager = sdk.SessionManager.create(cwd, path.join(cwd, 'host-sessions'));
  const settings = sdk.SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
  let hostContext;
  const capture = pi => { pi.on('session_start', (_event, ctx) => { hostContext = ctx; }); };
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [schedule, capture] });
  await loader.reload();
  const { session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: 'off', tools: ['read'], settingsManager: settings, sessionManager: manager, resourceLoader: loader });
  try {
    await session.bindExtensions({ mode: 'rpc' });
    await until(() => !!hostContext?.scheduledExecution, mode + ' native host context');
    const storage = new CronStorage(cwd);
    const job = resilientDefinition({ id: mode, name: mode, type: 'interval', schedule: '1s', intervalMs: 1000, prompt: 'Consume this authorized synthetic saved result, never repeat a completed read.', enabled: true, createdAt: new Date().toISOString(), runCount: 0, session: manager.getSessionId(), maxRuns: 2, maxRunsPerDay: 2, expiresAt: new Date(Date.now() + 300_000).toISOString(), deadlineMs: 20_000, ...(mode === 'model' ? { model: faux.getModel().provider + '/' + faux.getModel().id, extensions: true } : {}) }, { intervalMode: 'fixed-delay', workBudgetMs: 15_000, latenessMs: 30_000 });
    fs.mkdirSync(path.dirname(storage.getStorePath()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(storage.getStorePath(), JSON.stringify({ version: 4, jobs: [job] }), { mode: 0o600 });
    const callbackObservations = [];
    faux.setResponses([
      ai.fauxAssistantMessage(ai.fauxToolCall('read', { path: artifact }, { id: 'saved-read-' + mode }), { stopReason: 'toolUse' }),
      context => {
        if (mode === 'inline') hostContext.scheduledExecution.active?.checkpoint({ nextAction, artifacts: [{ ref: artifact, sha256: createHash('sha256').update(saved).digest('hex') }] });
        callbackObservations.push({ phase: 'first-failure', messages: context.messages });
        return overload();
      },
      overload(), overload(),
      context => {
        const text = JSON.stringify(context.messages);
        const results = context.messages.filter(message => message.role === 'toolResult' && message.toolCallId === 'saved-read-' + mode);
        callbackObservations.push({ phase: 'continuation', messages: context.messages, text });
        assert(text.includes(nextAction), 'Actual second-run model request must contain declarations/nextAction, not just an entry pointer');
        assert(text.includes('completedResultCount') && text.includes(createHash('sha256').update(saved).digest('hex')), 'Actual second-run model request must contain checkpoint result/artifact metadata');
        assert(results.length === 1 && JSON.stringify(results[0]).includes(saved), 'Actual second-run model request must retain the real completed tool result');
        return ai.fauxAssistantMessage('NATIVE_CHECKPOINT_CONSUMED_' + mode);
      },
    ]);
    // Load the newly created synthetic definition through the real extension lifecycle.
    await session.extensionRunner.emit({ type: 'session_start', reason: 'reload' });
    await until(() => storage.getJob(mode)?.attemptHistory?.length === 1, mode + ' first exact native closure');
    const first = storage.getJob(mode);
    // Both real extension loadouts have tool lifecycle hooks, so UNKNOWN is required before reconciliation.
    assert.equal(first.runtime.slot.phase, 'reconciling'); assert.equal(first.attemptCount, 1); assert.equal(first.enabled, true);
    assert.equal(first.attemptHistory[0].outcome, 'deferred'); assert.equal(first.attemptHistory[0].effectStatus, 'unknown'); assert.equal(faux.state.callCount, 4);
    const firstRef = first.attemptHistory[0].checkpoint;
    assert(firstRef.sessionFile && fs.existsSync(firstRef.sessionFile));
    const diskFirst = sdk.SessionManager.open(firstRef.sessionFile);
    const checkpoint = diskFirst.getEntry(firstRef.entryId);
    assert.equal(checkpoint?.customType, 'pi.scheduled-checkpoint.v1'); assert.equal(checkpoint.data.completedResultCount, 1); assert.equal(checkpoint.data.declarations.nextAction, nextAction);
    const realResult = diskFirst.getEntry(checkpoint.data.completedResults[0].entryId);
    assert.equal(realResult?.message?.toolCallId, 'saved-read-' + mode); assert(JSON.stringify(realResult).includes(saved));
    // Synthetic business owner reconciles this exact known read/checkpoint. No old record is rewritten,
    // no expiry/limit/cooldown is extended, and no original action is reposted for acceptance.
    const immutable = structuredClone(first.attemptHistory);
    const evidence = createHash('sha256').update(JSON.stringify({ checkpoint: firstRef, actualResultEntry: realResult.id, savedHash: createHash('sha256').update(saved).digest('hex') })).digest('hex');
    assert(storage.reconcileResilientAttempt(mode, manager.getSessionId(), first.attemptHistory[0].id, evidence, 'continue'));
    assert.deepEqual(storage.getJob(mode).attemptHistory, immutable);
    await session.waitForIdle();
    await session.extensionRunner.emit({ type: 'session_start', reason: 'reload' });
    await until(() => storage.getJob(mode)?.attemptHistory?.length === 2, mode + ' checkpoint continuation');
    const final = storage.getJob(mode);
    assert.equal(final.attemptCount, 2); assert.equal(final.enabled, true); assert.equal(final.runtime.slot.phase, 'finished');
    assert.equal(final.attemptHistory[1].outcome, 'completed'); assert.equal(final.attemptHistory[1].businessOutcome, 'unverified');
    assert.equal(final.attemptHistory[1].checkpoint.sessionId, firstRef.sessionId); assert.equal(final.attemptHistory[1].checkpoint.sessionFile, firstRef.sessionFile);
    const diskFinal = sdk.SessionManager.open(firstRef.sessionFile);
    const reads = diskFinal.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === 'saved-read-' + mode);
    assert.equal(reads.length, 1, 'Completed tool must not be replayed'); assert.equal(faux.state.callCount, 5);
    assert.equal(session.scheduledExecution.active, undefined); assert.equal(callbackObservations.filter(item => item.phase === 'continuation').length, 1);
    const before = settings.getRetrySettings();
    faux.setResponses([overload(), ai.fauxAssistantMessage('ORDINARY_USER_PROFILE_' + mode)]);
    await session.prompt('Ordinary separate synthetic user turn after the schedule is finished');
    assert.equal(faux.state.callCount, 7); assert.deepEqual(settings.getRetrySettings(), before);
    return { mode, attempts: final.attemptCount, nativeRequests: 5, businessOutcome: 'unverified', completedReads: reads.length, firstUnknownRetained: final.attemptHistory[0].effectStatus === 'unknown', exactOwnerReconciliation: final.attemptResolutions.length > 0, actualCheckpointInModelContext: true, ordinaryUserRetryRestored: true, nativeSessionId: firstRef.sessionId, nativeSessionFile: firstRef.sessionFile };
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
  }
}
const results = await Promise.all(['inline', 'model'].map(nativeCase));
fs.writeFileSync(path.join(root, 'observed.json'), JSON.stringify({ passed: true, root, results }, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, root, results }, null, 2));
