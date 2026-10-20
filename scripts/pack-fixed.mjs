#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || path.join(root, 'tmp/release'));
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
if (git('status', '--porcelain=v1')) throw new Error('Fixed payloads require a clean committed source checkout');
const sha = git('rev-parse', 'HEAD');
fs.mkdirSync(output, { recursive: true });
execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', output, '--json'], { cwd: root, encoding: 'utf8' }))[0];
const hash = data => createHash('sha256').update(data).digest('hex');
const archive = path.join(output, packed.filename);
const files = packed.files.map(entry => ({ path: entry.path, size: entry.size, sha256: hash(fs.readFileSync(path.join(root, entry.path))) }));
if (files.some(entry => /^(tmp|test|node_modules)\//.test(entry.path))) throw new Error('Unexpected private/test/dependency payload');
const provenanceName = `${packed.name}-${packed.version}.provenance.json`;
const provenance = { schemaVersion: 1, repository: 'chenhaoxiang/pi-schedule-prompt', sourceSha: sha,
  name: packed.name, version: packed.version, archive: packed.filename, archiveSha256: hash(fs.readFileSync(archive)), files };
fs.writeFileSync(path.join(output, provenanceName), JSON.stringify(provenance, null, 2) + '\n');
fs.writeFileSync(path.join(output, 'SHA256SUMS'), `${provenance.archiveSha256}  ${packed.filename}\n${hash(fs.readFileSync(path.join(output, provenanceName)))}  ${provenanceName}\n`);
console.log(JSON.stringify({ sourceSha: sha, version: packed.version, archive, provenance: path.join(output, provenanceName), checksums: path.join(output, 'SHA256SUMS'), files: files.length }));
