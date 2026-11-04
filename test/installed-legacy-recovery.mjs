// Actual SDK/extension integration over owned synthetic metadata only. No real store/provider/history.
// node test/installed-legacy-recovery.mjs <installed-package> <sdk-package> <owned-output>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
const [packageArg, hostArg, outputArg] = process.argv.slice(2); assert(packageArg && hostArg && outputArg);
const packageRoot = fs.realpathSync(packageArg); const host = fs.realpathSync(hostArg); const output = path.resolve(outputArg);
fs.mkdirSync(output, { recursive: true }); const root = fs.mkdtempSync(path.join(output, 'case-')); const agentDir = path.join(root, 'agent'); fs.mkdirSync(agentDir);
process.env.HOME = root; process.env.PI_CODING_AGENT_DIR = agentDir;
const sdk = await import(pathToFileURL(path.join(host, 'dist/index.js')).href);
const ai = await import(pathToFileURL(path.join(path.dirname(host), 'pi-ai/dist/index.js')).href);
const { CronStorage } = await import(pathToFileURL(path.join(packageRoot, 'dist/storage.js')).href);
const { requiresReconciliation } = await import(pathToFileURL(path.join(packageRoot, 'dist/resilient-policy.js')).href);
const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsStore: new ai.InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
const faux = ai.fauxProvider({ provider: 'legacy-recovery-fixture' }); runtime.registerNativeProvider(faux.provider);
const settings = sdk.SettingsManager.inMemory({ packages: [packageRoot], cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } });
const manager = sdk.SessionManager.inMemory(root); const owner = manager.getSessionId();
const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noExtensions: false, disabledBuiltinExtensions: ['mcp', 'llama.cpp', 'codemode', 'tool-search'], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload();
const storage = new CronStorage(root); const now = new Date().toISOString(); const expiry = new Date(Date.now() + 86400000).toISOString();
const legacy = (id, session, spent, maxRuns) => ({ id, name: id, revision: 1, type: 'cron', schedule: '0 0 * * * *', prompt: 'SYNTHETIC METADATA ONLY', enabled: false, session, durable: true, createdAt: now, runCount: spent, attemptCount: spent, maxRuns, maxRunsPerDay: 24, expiresAt: expiry, deadlineMs: 2700000, lastStatus: 'unknown', claim: { id: 'claim-' + id, binding: 'c'.repeat(64), sessionId: session, ownerId: 'synthetic-owner', ownerPid: process.pid, phase: 'settled', outcome: 'unknown', claimedAt: now, deadlineAt: now } });
const ancestor = legacy('root', 'previous-owner', 1, 158); const parent = legacy('old', 'previous-owner', 31, 157); const child = legacy('child', owner, 4, 126);
ancestor.recovery = { claimId: ancestor.claim.id, successorJobId: parent.id, evidenceFingerprint: 'f'.repeat(64), resumedAt: now };
parent.recovery = { claimId: parent.claim.id, successorJobId: child.id, evidenceFingerprint: 'a'.repeat(64), resumedAt: now };
storage.addJob(ancestor); storage.addJob(parent); storage.addJob(child);
const { session } = await sdk.createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: 'off', tools: ['schedule_prompt'], settingsManager: settings, sessionManager: manager, resourceLoader: loader });
try {
 await session.bindExtensions({ mode: 'rpc' });
 const handover = { predecessorJobId: parent.id, successorJobId: child.id, fromSessionId: parent.session, toSessionId: child.session, claimId: parent.claim.id, claimBinding: parent.claim.binding, recoveryEvidenceFingerprint: parent.recovery.evidenceFingerprint, handoverEvidenceFingerprint: createHash('sha256').update('synthetic owner handover only').digest('hex'), evidenceRef: 'synthetic:exact-owner-handover' };
 storage.migrateJobToSchema4(child.id, owner, { expectedSha256: storage.previewSchema4Migration().originalSha256, policy: { timezone: 'UTC' }, legacyHandovers: [handover], inspectRuntime: () => {
   assert(root.startsWith(output + path.sep)); assert.equal(session.isStreaming, false); assert.equal(session.scheduledExecution?.active, undefined);
   return { status: 'verified', activeRunIds: [], incompatibleWriterIds: [] };
 }});
 await session.extensionRunner.emit({ type: 'session_start', reason: 'reload' });
 const evidence = createHash('sha256').update('synthetic effect independently checked; no real effects exist').digest('hex'); let observedRuntime;
 const resultText = (context, id) => { const result = context.messages.find(m => m.role === 'toolResult' && m.toolCallId === id); assert(result && !result.isError); return result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'); };
 faux.setResponses([
   ai.fauxAssistantMessage(ai.fauxToolCall('schedule_prompt', { action: 'status', jobId: child.id }, { id: 'runtime-readback' }), { stopReason: 'toolUse' }),
   context => { observedRuntime = JSON.parse(resultText(context, 'runtime-readback')).runtime; assert.equal(observedRuntime.sessionId, owner); assert.equal(observedRuntime.pid, process.pid); assert.equal(observedRuntime.loadedSchedule.commandPath, path.join(packageRoot, 'src/index.ts')); assert.deepEqual(observedRuntime.loadedSchedule.readerSchemas, [1,2,3,4]); return ai.fauxAssistantMessage(ai.fauxToolCall('schedule_prompt', { action: 'reconcile', jobId: child.id, claimId: child.claim.id, claimBinding: child.claim.binding, evidenceFingerprint: evidence, resolution: 'continue' }, { id: 'legacy-reconciliation' }), { stopReason: 'toolUse' }); },
   context => { assert(resultText(context, 'legacy-reconciliation').includes('recorded')); return ai.fauxAssistantMessage('SYNTHETIC_FUTURE_ONLY_LEGACY_RECONCILED'); },
 ]);
 await session.prompt('Synthetic authorized operator: inspect this fixture runtime and reconcile the exact synthetic legacy claim; do not enable or run it.');
 const final = storage.getJob(child.id); assert.equal(requiresReconciliation(final), false); assert.equal(final.enabled, false); assert.equal(final.attemptCount, 36); assert.equal(final.maxRuns, 158); assert.equal(final.expiresAt, expiry); assert.equal(final.deadlineMs, 2700000); assert.deepEqual(final.claim, child.claim); assert.equal(final.attemptHistory.length, 0); assert.equal(final.runtime.lastFinishedAt, undefined); assert.equal(faux.state.callCount, 3); assert.equal(storage.getAllJobs().length, 3); assert.deepEqual(storage.getJob(ancestor.id), ancestor); assert.deepEqual(storage.getJob(parent.id), parent); assert.deepEqual(final.legacyLineage, [ancestor.id, parent.id]);
 const observed = { passed: true, root, hostVersion: JSON.parse(fs.readFileSync(path.join(host, 'package.json'))).version, runtime: observedRuntime, sameLogicalJob: true, nativeHistoryFabricated: false, enabledAutomatically: false, immutableLegacyClaimRetained: true, spent: final.attemptCount, maxRuns: final.maxRuns, remaining: final.maxRuns-final.attemptCount, modelRequests: faux.state.callCount, syntheticOnly: true, realStoreTouched: false, realProviderCalls: 0 };
 fs.writeFileSync(path.join(root, 'observed.json'), JSON.stringify(observed,null,2)+'\n'); console.log(JSON.stringify(observed,null,2));
} finally { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
