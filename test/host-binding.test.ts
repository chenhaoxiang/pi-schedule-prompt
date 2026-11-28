import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindingMismatch, bindPeers, ensureBound, isStableHostVersion, readHost, sameSource, writeReceiptHost } from "../scripts/host-binding.mjs";

const owned: string[] = [];
afterEach(() => { for (const root of owned.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

/** A synthetic Pi host installation: three lockstep peers next to the coding agent, plus typebox. */
const fixtures = path.resolve("tmp/host-binding-fixtures");
function scratch(prefix: string) {
  fs.mkdirSync(fixtures, { recursive: true });
  return fs.mkdtempSync(path.join(fixtures, prefix));
}
function host(version = "1.7.0-fork.1", root?: string) {
  const base = root ?? scratch("host-");
  owned.push(base);
  const scope = path.join(base, "node_modules/@earendil-works");
  for (const name of ["pi-coding-agent", "pi-ai", "pi-tui"]) {
    fs.mkdirSync(path.join(scope, name), { recursive: true });
    fs.writeFileSync(path.join(scope, name, "package.json"), JSON.stringify({ name: `@earendil-works/${name}`, version, ...(name === "pi-coding-agent" ? { dependencies: { typebox: "1.3.27" } } : {}) }));
  }
  const typebox = path.join(base, "node_modules/typebox");
  fs.mkdirSync(path.join(typebox, "build"), { recursive: true });
  fs.writeFileSync(path.join(typebox, "package.json"), JSON.stringify({ name: "typebox", version: "1.3.27", exports: { ".": { default: "./build/index.mjs" } } }));
  fs.writeFileSync(path.join(typebox, "build/index.mjs"), "export const Type = {};\n");
  return { root: path.join(scope, "pi-coding-agent"), base, version };
}

/** An installation directory holding only what the binding touches. */
function installation() {
  const dir = scratch("install-");
  owned.push(dir);
  fs.mkdirSync(path.join(dir, ".runtime/node_modules"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".install-receipt.json"), JSON.stringify({ sourceSha: "a".repeat(40), archiveSha256: "b".repeat(64), version: "0.5.1-fork.5", hostVersion: "1.6.0-fork.2", hostPath: "/elsewhere/pi-coding-agent" }) + "\n", { mode: 0o600 });
  return dir;
}

describe("host binding", () => {
  it.each(["1.3.0", "1.6.0-fork.1", "1.7.0-fork.1", "1.10.0", "1.12.3-fork.12"])("accepts the stable host version %s", version => {
    expect(isStableHostVersion(version)).toBe(true);
  });

  it.each(["1.2.9", "2.0.0", "1.7.0-beta.1", "1.7.0-fork.0", "1.7.0-fork.01", "v1.7.0", ""])("refuses the host version %s", version => {
    expect(isStableHostVersion(version)).toBe(false);
  });

  it("reads a host and fails closed on identity drift", () => {
    const h = host();
    const read = readHost(h.root);
    expect(read.version).toBe("1.7.0-fork.1");
    expect(read.peers.map(peer => peer.name)).toEqual(["pi-coding-agent", "pi-ai", "pi-tui"]);
    expect(read.typeboxVersion).toBe("1.3.27");

    const older = host("1.2.0");
    expect(() => readHost(older.root)).toThrow(/recognized stable Pi/);

    const drifted = host();
    fs.writeFileSync(path.join(drifted.base, "node_modules/@earendil-works/pi-ai/package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", version: "1.6.0" }));
    expect(() => readHost(drifted.root)).toThrow(/peer versions differ/);

    const foreignTypebox = host();
    fs.writeFileSync(path.join(foreignTypebox.base, "node_modules/typebox/package.json"), JSON.stringify({ name: "typebox", version: "1.3.28", exports: { ".": { default: "./build/index.mjs" } } }));
    expect(() => readHost(foreignTypebox.root)).toThrow(/typebox identity\/version mismatch/);
  });

  it("binds idempotently, reports the mismatch it fixes and never replaces a real directory", () => {
    const h = host();
    const install = installation();
    expect(bindingMismatch(install, readHost(h.root))).toMatch(/missing/);
    bindPeers(install, readHost(h.root));
    expect(bindingMismatch(install, readHost(h.root))).toBeNull();
    const first = fs.lstatSync(path.join(install, ".runtime/node_modules/typebox")).ino;
    bindPeers(install, readHost(h.root));
    expect(fs.lstatSync(path.join(install, ".runtime/node_modules/typebox")).ino).not.toBe(first);

    // A directory (not our link) is somebody else's: refuse rather than delete it.
    fs.rmSync(path.join(install, ".runtime/node_modules/typebox"));
    fs.mkdirSync(path.join(install, ".runtime/node_modules/typebox"));
    expect(() => bindPeers(install, readHost(h.root))).toThrow(/Host typebox binding mismatch/);
  });

  it("moves only the host fields of an existing receipt", () => {
    const h = host();
    const install = installation();
    bindPeers(install, readHost(h.root));
    const updated = writeReceiptHost(install, readHost(h.root));
    expect(updated).toMatchObject({ sourceSha: "a".repeat(40), archiveSha256: "b".repeat(64), version: "0.5.1-fork.5", hostVersion: "1.7.0-fork.1" });
    expect(sameSource(updated, { sourceSha: "a".repeat(40), archiveSha256: "b".repeat(64), version: "0.5.1-fork.5" })).toBe(true);
    expect(sameSource(updated, { sourceSha: "c".repeat(40), archiveSha256: "b".repeat(64), version: "0.5.1-fork.5" })).toBe(false);
    expect(fs.statSync(path.join(install, ".install-receipt.json")).mode & 0o777).toBe(0o600);
  });

  it("follows a moved host without touching the installed source files", () => {
    const first = host("1.6.0-fork.2");
    const install = installation();
    bindPeers(install, readHost(first.root));
    writeReceiptHost(install, readHost(first.root));
    const second = host("1.7.0-fork.1");
    expect(bindingMismatch(install, readHost(second.root))).toMatch(/another host/);
    bindPeers(install, readHost(second.root));
    writeReceiptHost(install, readHost(second.root));
    expect(bindingMismatch(install, readHost(second.root))).toBeNull();
    expect(fs.realpathSync(path.join(install, ".runtime/node_modules/@earendil-works/pi-ai"))).toBe(fs.realpathSync(path.join(second.base, "node_modules/@earendil-works/pi-ai")));
    expect(JSON.parse(fs.readFileSync(path.join(install, ".install-receipt.json"), "utf8")).hostVersion).toBe("1.7.0-fork.1");
  });

  it("rebinds an installed plugin once and then leaves it alone", () => {
    const first = host("1.6.0-fork.2");
    const install = installation();
    bindPeers(install, readHost(first.root));
    writeReceiptHost(install, readHost(first.root));
    expect(ensureBound(install, readHost(first.root))).toBe(false);

    const moved = host("1.7.0-fork.1");
    expect(ensureBound(install, readHost(moved.root))).toBe(true);
    expect(bindingMismatch(install, readHost(moved.root))).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(install, ".install-receipt.json"), "utf8"))).toMatchObject({ hostVersion: "1.7.0-fork.1", hostPath: fs.realpathSync(moved.root) });
    // Idempotent: a second start against the same host writes nothing and reports no change.
    expect(ensureBound(install, readHost(moved.root))).toBe(false);
  });

  it("refuses to rebind an installation whose peers were replaced by real directories", () => {
    const moved = host("1.7.0-fork.1");
    const install = installation();
    bindPeers(install, readHost(host("1.6.0-fork.2").root));
    fs.rmSync(path.join(install, ".runtime/node_modules/@earendil-works/pi-ai"));
    fs.mkdirSync(path.join(install, ".runtime/node_modules/@earendil-works/pi-ai"));
    expect(() => ensureBound(install, readHost(moved.root))).toThrow(/Host peer binding mismatch/);
  });

  it("keeps the shared module free of provider or network access", () => {
    const source = fs.readFileSync(path.resolve("scripts/host-binding.mjs"), "utf8");
    for (const forbidden of ["fetch(", "http", "child_process"]) expect(source).not.toContain(forbidden);
    // The scripts that use it stay syntax-checkable on their own.
    for (const script of ["scripts/host-binding.mjs", "scripts/install-fixed.mjs", "scripts/supervisor.mjs"]) expect(execFileSync(process.execPath, ["--check", script], { encoding: "utf8" })).toBe("");
  });
});
