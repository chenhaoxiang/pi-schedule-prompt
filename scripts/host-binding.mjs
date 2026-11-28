/**
 * The one place that answers "which Pi host is this installation bound to, and is that still
 * the host that is running?".
 *
 * The fixed installation keeps the three SDK peers and typebox as symlinks into the host that
 * installed it, so the plugin never loads a second copy of pi-ai/pi-tui in the same process as
 * the CLI. A Pi upgrade moves the host to a new directory, so the links have to follow it: the
 * binding is a CURRENT FACT to re-derive from the running CLI, not an immutable part of the
 * installation's identity. Source and artefact identity (sourceSha, archiveSha256, version)
 * stay fixed; only the host fields move.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const HOST_PACKAGE = '@earendil-works/pi-coding-agent';
export const PEER_PACKAGES = ['pi-coding-agent', 'pi-ai', 'pi-tui'];
/** Canonical Pi host version this plugin can run on: 1.x from 1.3 on (native custom turns and
 *  the capability the scheduler negotiates), stable or a maintained fork revision. A 1.2 host has
 *  no native scheduled turns; a 2.x host is a different compatibility line that has not been
 *  reviewed. The upper bound is deliberately absent so a new 1.x minor needs no code change. */
export const STABLE_HOST_VERSION = /^1\.(?:[3-9]|\d{2,})\.\d+(?:-fork\.[1-9]\d*)?$/;

export const isStableHostVersion = value =>
  typeof value === 'string' && STABLE_HOST_VERSION.test(value);

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function typeboxRoot(hostRoot, pkg) {
  const entry = fs.realpathSync(createRequire(path.join(hostRoot, 'package.json')).resolve('typebox'));
  let current = path.dirname(entry);
  while (!fs.existsSync(path.join(current, 'package.json'))) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Host typebox package identity unavailable');
    current = parent;
  }
  const candidates = [path.join(hostRoot, 'node_modules/typebox'), path.join(path.dirname(path.dirname(hostRoot)), 'typebox')]
    .filter(target => fs.existsSync(target))
    .map(target => fs.realpathSync(target));
  if (!candidates.includes(current)) throw new Error('Host typebox must resolve inside the selected host installation');
  const typebox = readJson(path.join(current, 'package.json'));
  if (typebox.name !== 'typebox' || !/^\d+\.\d+\.\d+$/.test(typebox.version) || typebox.version !== pkg.dependencies?.typebox) {
    throw new Error('Host typebox identity/version mismatch');
  }
  return current;
}

/** Read and validate one Pi host installation: package identity, version shape, the lockstep
 *  SDK peers next to it and its own typebox. Anything unexpected fails closed. */
export function readHost(hostRoot) {
  const root = fs.realpathSync(hostRoot);
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg.name !== HOST_PACKAGE) throw new Error('Expected the maintained Pi host package');
  if (!isStableHostVersion(pkg.version)) throw new Error('Expected a recognized stable Pi 1.x host');
  const peers = PEER_PACKAGES.map(name => {
    const directory = path.join(path.dirname(root), name);
    const manifest = readJson(path.join(directory, 'package.json'));
    if (manifest.name !== `@earendil-works/${name}`) throw new Error(`Host peer identity mismatch: ${name}`);
    if (manifest.version !== pkg.version) throw new Error(`Host peer versions differ: ${name}`);
    return { name, path: fs.realpathSync(directory) };
  });
  const typebox = typeboxRoot(root, pkg);
  return {
    root,
    version: pkg.version,
    peers,
    typeboxPath: typebox,
    typeboxVersion: readJson(path.join(typebox, 'package.json')).version,
  };
}

const link = (target, destination) => {
  const temporary = `${destination}.binding-${process.pid}`;
  fs.rmSync(temporary, { force: true });
  fs.symlinkSync(target, temporary, 'dir');
  fs.renameSync(temporary, destination);
};

const isOurLink = (destination, hostScope) => {
  let stat;
  try {
    stat = fs.lstatSync(destination);
  } catch {
    return 'missing';
  }
  if (!stat.isSymbolicLink()) return 'not-a-link';
  const target = fs.readlinkSync(destination);
  // Only ever replace a link that points into a Pi host installation; a real directory or a
  // link to somewhere else is somebody else's and fails closed above.
  return /(?:^|[/\\])node_modules[/\\](?:@earendil-works[/\\])?/.test(target) ? 'ours' : 'foreign';
};

/** Point the installation's peers and typebox at `host`. Idempotent; replaces only our own
 *  links and refuses a directory or a foreign link. */
export function bindPeers(installDir, host) {
  const modules = path.join(installDir, '.runtime', 'node_modules');
  const scope = path.join(modules, '@earendil-works');
  fs.mkdirSync(scope, { recursive: true, mode: 0o700 });
  for (const peer of host.peers) {
    const destination = path.join(scope, peer.name);
    const state = isOurLink(destination, scope);
    if (state === 'not-a-link' || state === 'foreign') throw new Error(`Host peer binding mismatch: ${peer.name} is not our link (${destination})`);
    link(peer.path, destination);
  }
  const typebox = path.join(modules, 'typebox');
  const state = isOurLink(typebox, modules);
  if (state === 'not-a-link' || state === 'foreign') throw new Error(`Host typebox binding mismatch: not our link (${typebox})`);
  link(host.typeboxPath, typebox);
}

/** What is wrong with the installation's binding to `host`, or null when it already matches. */
export function bindingMismatch(installDir, host) {
  const modules = path.join(installDir, '.runtime', 'node_modules');
  for (const peer of host.peers) {
    const destination = path.join(modules, '@earendil-works', peer.name);
    let actual;
    try {
      actual = fs.realpathSync(destination);
    } catch {
      return `peer ${peer.name} is missing`;
    }
    if (actual !== peer.path) return `peer ${peer.name} resolves to another host`;
  }
  let typebox;
  try {
    typebox = fs.realpathSync(path.join(modules, 'typebox'));
  } catch {
    return 'typebox is missing';
  }
  if (typebox !== host.typeboxPath) return 'typebox resolves to another host';
  return null;
}

/** Update only the host fields of an installation receipt. */
export function writeReceiptHost(installDir, host) {
  const file = path.join(installDir, '.install-receipt.json');
  const receipt = readJson(file);
  const next = { ...receipt, hostVersion: host.version, hostPath: host.root, hostTypeboxPath: host.typeboxPath, hostTypeboxVersion: host.typeboxVersion };
  fs.writeFileSync(file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  return next;
}

/**
 * Make an existing installation follow `host`, if it does not already.
 *
 * This is what a Pi upgrade needs: the source files stay as installed, only the peers, typebox and
 * the receipt's host fields move. Returns true when something changed. Throws when the links are
 * not ours to replace, or when the rebind did not take.
 */
export function ensureBound(installDir, host) {
  const file = path.join(installDir, '.install-receipt.json');
  const receipt = readJson(file);
  const peersMatch = bindingMismatch(installDir, host) === null;
  if (peersMatch && receipt.hostPath === host.root && receipt.hostVersion === host.version &&
      receipt.hostTypeboxPath === host.typeboxPath && receipt.hostTypeboxVersion === host.typeboxVersion) {
    return false;
  }
  bindPeers(installDir, host);
  writeReceiptHost(installDir, host);
  if (bindingMismatch(installDir, host) !== null) throw new Error('CLI and fixed installer host bindings differ');
  return true;
}

/** Whether a receipt describes the same source/artefact as `expected` (everything but the host). */
export function sameSource(receipt, { sourceSha, archiveSha256, version }) {
  return receipt?.sourceSha === sourceSha && receipt?.archiveSha256 === archiveSha256 && receipt?.version === version;
}
