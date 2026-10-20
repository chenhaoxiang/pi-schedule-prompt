#!/usr/bin/env node
// Isolated real Pi SDK/RPC host: no HOME discovery, network, credentials, or paid provider.
import * as fs from 'node:fs';
import * as path from 'node:path';
fs.mkdirSync(path.join(process.cwd(), 'tmp'), { recursive: true });
const originalStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (...args) => { fs.appendFileSync(path.join(process.cwd(), 'tmp/native-fixture-stderr'), args[0]); return originalStderr(...args); };
try {
const sdk = await import(process.env.PI_SCHEDULE_HOST_ENTRY || '@earendil-works/pi-coding-agent');
const ai = await import(process.env.PI_SCHEDULE_AI_ENTRY || '@earendil-works/pi-ai');
const { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager, runRpcMode } = sdk;
const { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } = ai;
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const cwd = process.cwd();
const agentDir = path.join(cwd, 'fixture-agent'); fs.mkdirSync(agentDir, { recursive: true });
const sessionDir = arg('--session-dir'); const id = arg('--session-id'); const packageRoot = arg('--extension');
const sessions = await SessionManager.list(cwd, sessionDir);
const previous = sessions.find(info => info.id === id);
const manager = previous ? SessionManager.open(previous.path, sessionDir, cwd) : SessionManager.create(cwd, sessionDir, { id });
const faux = fauxProvider({ provider: 'durable-fixture', models: [{ id: 'fixture' }] });
faux.setResponses([async () => {
  fs.appendFileSync(path.join(cwd, 'inference-started'), 'synthetic\n');
  if (process.env.SCHEDULE_FIXTURE_DELAY === '1') await new Promise(resolve => setTimeout(resolve, 1500));
  return fauxAssistantMessage('DURABLE_RPC_OK');
}]);
const createRuntime = async ({ sessionManager, sessionStartEvent }) => {
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoaderOptions = { noExtensions: false, noSkills: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [path.join(packageRoot, 'src/index.ts')],
    extensionFactories: process.env.SCHEDULE_FIXTURE_UI === '1' ? [pi => { pi.on('session_start', (_event, ctx) => { setTimeout(async () => { const confirmed = await ctx.ui.confirm('fixture', 'synthetic consent'); fs.writeFileSync(path.join(cwd, 'ui-denied'), String(!confirmed)); }, 300); }); }] : [] };
  const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager, resourceLoaderOptions });
  return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel(), thinkingLevel: 'off', noTools: true })), services, diagnostics: services.diagnostics };
};
const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: manager });
// The native mode owns lifecycle, LF framing, extension UI and EOF disposal.
await runRpcMode(runtime);
} catch (error) {
  fs.mkdirSync(path.join(process.cwd(), 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'tmp/native-fixture-error'), String(error.stack));
  process.exitCode = 1;
}
