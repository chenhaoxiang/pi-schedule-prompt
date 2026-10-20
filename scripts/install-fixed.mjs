#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

const [archiveArg, provenanceArg, expectedSha, rootArg] = process.argv.slice(2);
if (!archiveArg || !provenanceArg || !/^[a-f0-9]{40}$/.test(expectedSha || '')) {
  throw new Error('Usage: node scripts/install-fixed.mjs <archive> <provenance> <trusted-source-sha> [install-root]');
}
const archive = path.resolve(archiveArg);
const provenancePath = path.resolve(provenanceArg);
const metadata = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
if (metadata.schemaVersion !== 1 || metadata.repository !== 'chenhaoxiang/pi-schedule-prompt' || metadata.sourceSha !== expectedSha || !/^\d+\.\d+\.\d+-fork\.\d+$/.test(metadata.version) || !Array.isArray(metadata.files)) {
  throw new Error('Unexpected provenance or source binding');
}
const hash = data => createHash('sha256').update(data).digest('hex');
if (hash(fs.readFileSync(archive)) !== metadata.archiveSha256) throw new Error('Archive checksum mismatch');
const safe = value => typeof value === 'string' && value.length > 0 && !path.posix.isAbsolute(value) && !value.includes('\\') && !value.split('/').includes('..') && path.posix.normalize(value) === value;
const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 1048576 }).trim().split('\n');
const listing = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 1048576 }).trim().split('\n');
if (listing.some(line => !['-', 'd'].includes(line[0]))) throw new Error('Links or special archive entries are not accepted');
if (names.some(name => !safe(name.replace(/\/$/, '')) || !name.startsWith('package/'))) throw new Error('Unsafe archive member');
const expected = new Set(metadata.files.map(file => file.path));
if (expected.size !== metadata.files.length || metadata.files.some(file => !safe(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new Error('Unsafe/duplicate file manifest');
for (const name of names) if (!name.endsWith('/') && !expected.has(name.slice('package/'.length))) throw new Error('Unmanifested archive member');
const host = process.env.PI_SCHEDULE_HOST_PACKAGE_DIR;
if (!host || !path.isAbsolute(host)) throw new Error('Set PI_SCHEDULE_HOST_PACKAGE_DIR to the exact maintained Pi host package directory');
const hostRoot = fs.realpathSync(host);
const hostPackage = JSON.parse(fs.readFileSync(path.join(hostRoot, 'package.json'), 'utf8'));
if (hostPackage.name !== '@earendil-works/pi-coding-agent' || !/^1\.3\.\d+(?:-fork\.\d+)?$/.test(hostPackage.version)) throw new Error('Expected a Pi 1.3 host');
const root = path.resolve(rootArg || path.join(homedir(), '.pi/agent/packages/pi-schedule-prompt'));
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error('Install root must be an owned real directory');
const destination = path.join(root, metadata.version);
const verifyRuntime = directory => {
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries(pkg.dependencies || {})) {
    if (JSON.parse(fs.readFileSync(path.join(directory, 'node_modules', name, 'package.json'), 'utf8')).version !== version) throw new Error('Runtime dependency mismatch: ' + name);
  }
  for (const name of ['pi-coding-agent', 'pi-ai', 'pi-tui']) {
    if (fs.realpathSync(path.join(directory, 'node_modules/@earendil-works', name)) !== fs.realpathSync(path.join(path.dirname(hostRoot), name))) throw new Error('Host peer binding mismatch: ' + name);
  }
};
const verify = directory => {
  for (const file of metadata.files) {
    const target = path.join(directory, file.path);
    if (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink() || hash(fs.readFileSync(target)) !== file.sha256) throw new Error('Installed-byte mismatch: ' + file.path);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (pkg.version !== metadata.version || pkg.name !== 'pi-schedule-prompt') throw new Error('Package identity mismatch');
};
if (fs.existsSync(destination)) {
  verify(destination);
  verifyRuntime(destination);
  const receipt = JSON.parse(fs.readFileSync(path.join(destination, '.install-receipt.json'), 'utf8'));
  if (receipt.sourceSha !== expectedSha || receipt.archiveSha256 !== metadata.archiveSha256 || receipt.hostVersion !== hostPackage.version) throw new Error('Existing installation has a different source/host binding');
  console.log(JSON.stringify({ installed: destination, verified: true, runtimeReady: true, reused: true, sourceSha: expectedSha, globalSettingsChanged: false }));
} else {
  const temporaryRoot = path.join(root, 'tmp');
  fs.mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });
  const staging = path.join(temporaryRoot, 'install-' + randomUUID());
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    execFileSync('tar', ['-xzf', archive, '-C', staging, '--no-same-owner']);
    const unpacked = path.join(staging, 'package');
    verify(unpacked);
    const pkg = JSON.parse(fs.readFileSync(path.join(unpacked, 'package.json'), 'utf8'));
    if (Object.values(pkg.dependencies || {}).some(value => !/^\d+\.\d+\.\d+$/.test(value))) throw new Error('Runtime dependencies must be exact pins');
    const runtime = path.join(unpacked, '.runtime');
    fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ name: 'pi-schedule-fixed-runtime', version: '1.0.0', private: true, dependencies: pkg.dependencies }) + '\n');
    execFileSync('npm', ['install', '--prefix', runtime, '--omit=dev', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], { stdio: 'inherit' });
    const modules = path.join(runtime, 'node_modules');
    fs.mkdirSync(path.join(modules, '@earendil-works'), { recursive: true });
    for (const name of ['pi-coding-agent', 'pi-ai', 'pi-tui']) {
      const target = path.join(path.dirname(hostRoot), name);
      if (JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version !== hostPackage.version) throw new Error('Host peer versions differ');
      fs.symlinkSync(target, path.join(modules, '@earendil-works', name), 'dir');
    }
    fs.symlinkSync(path.join('.runtime', 'node_modules'), path.join(unpacked, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(unpacked, '.install-receipt.json'), JSON.stringify({ sourceSha: expectedSha, archiveSha256: metadata.archiveSha256, version: metadata.version, hostVersion: hostPackage.version }) + '\n', { mode: 0o600 });
    fs.renameSync(unpacked, destination);
    verify(destination);
    verifyRuntime(destination);
    console.log(JSON.stringify({ installed: destination, verified: true, runtimeReady: true, reused: false, sourceSha: expectedSha, globalSettingsChanged: false }));
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
