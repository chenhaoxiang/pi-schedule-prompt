// Explicit installed-package peer/diagnostic acceptance; no sessions, providers or live store.
// node test/installed-host-peers.mjs <package-root> <host-package-root> <owned-output-root>
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
const [packageArg, hostArg, outputArg] = process.argv.slice(2);
assert(packageArg && hostArg && outputArg, 'Explicit package, host and owned output are required');
const packageRoot = fs.realpathSync(packageArg); const hostRoot = fs.realpathSync(hostArg);
const output = path.resolve(outputArg); fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(output, 'case-')); const agentDir = path.join(root, 'agent');
fs.mkdirSync(agentDir, { mode: 0o700 }); process.env.HOME = root; process.env.PI_CODING_AGENT_DIR = agentDir;
const sdk = await import(pathToFileURL(path.join(hostRoot, 'dist/index.js')).href);
const extensionRequire = createRequire(path.join(packageRoot, 'package.json'));
const hostRequire = createRequire(path.join(hostRoot, 'package.json'));
const extensionEntry = fs.realpathSync(extensionRequire.resolve('typebox'));
const hostEntry = fs.realpathSync(hostRequire.resolve('typebox'));
const extensionTypebox = await import(pathToFileURL(extensionEntry).href);
const hostTypebox = await import(pathToFileURL(hostEntry).href);
// Use the settings package path, not a direct -e file: packageRoot metadata drives host warnings.
const settings = sdk.SettingsManager.inMemory({ packages: [packageRoot] });
const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noExtensions: false, disabledBuiltinExtensions: ['mcp', 'llama.cpp', 'codemode', 'tool-search'], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload();
const loaded = loader.getExtensions();
const warnings = (loaded.warnings ?? []).filter(entry => entry.warning.includes('Host-provided extension packages'));
const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(packageRoot, 'dist/runtime-lock.json'), 'utf8'));
const observed = { packageVersion: pkg.version, hostVersion: JSON.parse(fs.readFileSync(path.join(hostRoot, 'package.json'), 'utf8')).version, hostWarnings: warnings, extensionErrors: loaded.errors, manifestLoaded: loaded.extensions.some(entry => fs.realpathSync(entry.path) === fs.realpathSync(path.join(packageRoot, 'src/index.ts'))), extensionTypeboxEntry: extensionEntry, hostTypeboxEntry: hostEntry, samePhysicalTypebox: extensionEntry === hostEntry, sameBareNodeTypeObject: extensionTypebox.Type === hostTypebox.Type, runtimeDependencies: Object.keys(lock.packages[''].dependencies).sort(), nativeCapability: sdk.AgentSession.scheduledExecutionVersion ?? null, realProviderCalls: 0, activeSessionsReloaded: false, realStoreTouched: false };
fs.writeFileSync(path.join(root, 'observed.json'), JSON.stringify(observed, null, 2) + '\n');
console.log(JSON.stringify({ root, ...observed }, null, 2));
assert.equal(loaded.errors.length, 0); assert.equal(observed.manifestLoaded, true);
assert.equal(warnings.length, 0, 'Actual host loader must not emit a host-dependency warning');
assert.equal(observed.samePhysicalTypebox, true); assert.equal(observed.sameBareNodeTypeObject, true);
for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']) { assert.equal(pkg.peerDependencies[name], '*'); assert.equal(pkg.dependencies[name], undefined); }
assert.deepEqual(observed.runtimeDependencies, ['croner', 'nanoid']);
assert.equal(lock.packages['node_modules/typebox'], undefined);
