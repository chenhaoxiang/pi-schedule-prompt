import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const owned: string[] = [];
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
function fixture() {
  const base = path.resolve("tmp/install-fixtures");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "case-"));
  owned.push(root);
  const pkg = path.join(root, "package");
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "pi-schedule-prompt", version: "0.4.1-fork.99", dependencies: {} }));
  fs.writeFileSync(path.join(pkg, "README.md"), "synthetic fixture");
  fs.mkdirSync(path.join(pkg, "dist"));
  fs.writeFileSync(path.join(pkg, "dist/runtime-lock.json"), JSON.stringify({ name: "pi-schedule-fixed-runtime", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "pi-schedule-fixed-runtime", version: "1.0.0", dependencies: {} } } }));
  const archive = path.join(root, "package.tgz");
  execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
  const hostScope = path.join(root, "host/node_modules/@earendil-works");
  for (const name of ["pi-coding-agent", "pi-ai", "pi-tui"]) {
    const dir = path.join(hostScope, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@earendil-works/" + name, version: "1.3.0", ...(name === "pi-coding-agent" ? { dependencies: { typebox: "1.3.27" } } : {}) }));
  }
  const typebox = path.join(root, "host/node_modules/typebox");
  fs.mkdirSync(path.join(typebox, "build"), { recursive: true });
  fs.writeFileSync(path.join(typebox, "package.json"), JSON.stringify({ name: "typebox", version: "1.3.27", exports: { ".": { default: "./build/index.mjs" } } }));
  fs.writeFileSync(path.join(typebox, "build/index.mjs"), "export const Type = {};\n");
  const metadata = { schemaVersion: 1, repository: "chenhaoxiang/pi-schedule-prompt", sourceSha: "a".repeat(40),
    name: "pi-schedule-prompt", version: "0.4.1-fork.99", archiveSha256: hash(fs.readFileSync(archive)),
    files: ["package.json", "README.md", "dist/runtime-lock.json"].map(file => ({ path: file, sha256: hash(fs.readFileSync(path.join(pkg, file))) })) };
  const provenance = path.join(root, "provenance.json");
  const save = () => fs.writeFileSync(provenance, JSON.stringify(metadata));
  save();
  const install = (expected = metadata.sourceSha) => spawnSync(process.execPath,
    [path.resolve("scripts/install-fixed.mjs"), archive, provenance, expected, path.join(root, "installed")],
    { encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, npm_config_update_notifier: "false", npm_config_cache: path.join(root, "tmp/npm"),
      PI_SCHEDULE_HOST_PACKAGE_DIR: path.join(hostScope, "pi-coding-agent") }, timeout: 15000 });
  const repack = () => {
    execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
    metadata.archiveSha256 = hash(fs.readFileSync(archive));
    for (const file of metadata.files) file.sha256 = hash(fs.readFileSync(path.join(pkg, file.path)));
    save();
  };
  return { root, pkg, archive, metadata, save, install, repack };
}
afterEach(() => { for (const root of owned.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("fixed installation boundaries", () => {
  it("verifies exact source/files, installs privately and reuses only the same binding", () => {
    const f = fixture();
    const result = f.install();
    expect(result.status, result.stderr).toBe(0);
    const line = result.stdout.split("\n").find(value => value.startsWith('{"installed":'))!;
    const installed = JSON.parse(line).installed;
    expect(fs.readFileSync(path.join(installed, "README.md"), "utf8")).toBe("synthetic fixture");
    expect(fs.lstatSync(path.join(installed, "node_modules")).isSymbolicLink()).toBe(true);
    expect(fs.statSync(path.join(installed, ".install-receipt.json")).mode & 0o777).toBe(0o600);
    const receipt = JSON.parse(fs.readFileSync(path.join(installed, ".install-receipt.json"), "utf8"));
    expect(receipt.hostPath).toBe(fs.realpathSync(path.join(f.root, "host/node_modules/@earendil-works/pi-coding-agent")));
    expect(f.install().status).toBe(0);
    f.metadata.sourceSha = "b".repeat(40);
    f.save();
    expect(f.install().status).not.toBe(0);
  });

  it("declares host-provided packages only as wildcard peers and pins typebox for development", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
      expect(pkg.peerDependencies[name]).toBe("*"); expect(pkg.dependencies[name]).toBeUndefined();
    }
    expect(pkg.devDependencies.typebox).toBe("1.3.27");
    const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
    expect(lock.packages["node_modules/typebox"]).toMatchObject({ version: "1.3.27", dev: true });
  });

  it("binds the actual host-resolved typebox and rejects replacement by an independent copy", () => {
    const f = fixture(); const result = f.install(); expect(result.status, result.stderr).toBe(0);
    const installed = JSON.parse(result.stdout.split("\n").find(line => line.startsWith('{"installed":'))!).installed;
    const binding = path.join(installed, "node_modules/typebox");
    expect(fs.realpathSync(binding)).toBe(fs.realpathSync(path.join(f.root, "host/node_modules/typebox")));
    expect(fs.lstatSync(binding).isSymbolicLink()).toBe(true);
    fs.unlinkSync(binding); fs.cpSync(path.join(f.root, "host/node_modules/typebox"), binding, { recursive: true });
    const again = f.install(); expect(again.status).not.toBe(0); expect(again.stderr).toContain("Host typebox binding mismatch");
  });

  it("prefers a nested host typebox instead of a hoisted copy", () => {
    const f = fixture(); const host = path.join(f.root, "host/node_modules/@earendil-works/pi-coding-agent");
    const nested = path.join(host, "node_modules/typebox"); fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.cpSync(path.join(f.root, "host/node_modules/typebox"), nested, { recursive: true });
    const result = f.install(); expect(result.status, result.stderr).toBe(0);
    const installed = JSON.parse(result.stdout.split("\n").find(line => line.startsWith('{"installed":'))!).installed;
    expect(fs.realpathSync(path.join(installed, "node_modules/typebox"))).toBe(fs.realpathSync(nested));
  });

  it("refuses to reuse an installation after host typebox identity/version drifts", () => {
    const f = fixture(); expect(f.install().status).toBe(0);
    const file = path.join(f.root, "host/node_modules/typebox/package.json"); const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    pkg.version = "1.3.28"; fs.writeFileSync(file, JSON.stringify(pkg));
    const hostFile = path.join(f.root, "host/node_modules/@earendil-works/pi-coding-agent/package.json"); const host = JSON.parse(fs.readFileSync(hostFile, "utf8"));
    host.dependencies.typebox = "1.3.28"; fs.writeFileSync(hostFile, JSON.stringify(host));
    const again = f.install(); expect(again.status).not.toBe(0); expect(again.stderr).toContain("different source/host binding");
  });

  it.each(["missing", "version-mismatch", "wrong-name"])("refuses %s host typebox without publishing an installation", kind => {
    const f = fixture(); const typebox = path.join(f.root, "host/node_modules/typebox");
    if (kind === "missing") fs.rmSync(typebox, { recursive: true });
    else fs.writeFileSync(path.join(typebox, "package.json"), JSON.stringify({ name: kind === "wrong-name" ? "not-typebox" : "typebox", version: kind === "version-mismatch" ? "1.3.26" : "1.3.27", exports: { ".": { default: "./build/index.mjs" } } }));
    const result = f.install(); expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(f.root, "installed/0.4.1-fork.99"))).toBe(false);
  });

  it.each(["1.3.0-fork.1", "1.4.0-fork.5", "1.5.0-fork.2", "1.5.0-fork.3"])("binds exact canonical %s SDK peers without treating version metadata as native activation", version => {
    const f = fixture();
    for (const name of ["pi-coding-agent", "pi-ai", "pi-tui"]) fs.writeFileSync(path.join(f.root, "host/node_modules/@earendil-works", name, "package.json"), JSON.stringify({ name: "@earendil-works/" + name, version, ...(name === "pi-coding-agent" ? { dependencies: { typebox: "1.3.27" } } : {}) }));
    const result = f.install(); expect(result.status, result.stderr).toBe(0);
    const installed = JSON.parse(result.stdout.split("\n").find(line => line.startsWith('{"installed":'))!);
    expect(installed.hostVersion).toBe(version); expect(installed.globalSettingsChanged).toBe(false);
  });

  it.each(["1.2.0", "1.5.0-beta.1", "1.5.0-fork.0", "1.5.0-fork.01", "1.6.0", "2.0.0"])("refuses unqualified or noncanonical host %s", version => {
    const f = fixture(); fs.writeFileSync(path.join(f.root, "host/node_modules/@earendil-works/pi-coding-agent/package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }));
    const result = f.install(); expect(result.status).not.toBe(0); expect(result.stderr).toContain("recognized stable Pi"); expect(fs.existsSync(path.join(f.root, "installed"))).toBe(false);
  });

  it("refuses archive tampering before installation", () => {
    const f = fixture();
    fs.appendFileSync(f.archive, "tamper");
    const result = f.install();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checksum mismatch");
    expect(fs.existsSync(path.join(f.root, "installed"))).toBe(false);
  });

  it("refuses a different trusted source pin", () => {
    const f = fixture();
    expect(f.install("b".repeat(40)).status).not.toBe(0);
  });

  it("rejects unsafe manifest paths without extracting", () => {
    const f = fixture();
    f.metadata.files[0].path = "../escape";
    f.save();
    expect(f.install().status).not.toBe(0);
    expect(fs.existsSync(path.join(f.root, "escape"))).toBe(false);
  });
  it("rejects non-exact production pins before npm hydration", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.pkg, "package.json"), JSON.stringify({ name: "pi-schedule-prompt", version: "0.4.1-fork.99", dependencies: { synthetic: "^1.0.0" } }));
    f.repack();
    const result = f.install();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Runtime dependencies must be exact pins");
  });

  it("rejects a different host peer version", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, "host/node_modules/@earendil-works/pi-ai/package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", version: "1.2.0" }));
    const result = f.install();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Host peer versions differ");
  });

  it("rejects an actual archive symlink before extraction", () => {
    const f = fixture();
    fs.symlinkSync("../outside", path.join(f.pkg, "link"));
    f.repack();
    const result = f.install();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Links or special archive entries");
    expect(fs.existsSync(path.join(f.root, "installed"))).toBe(false);
  });

  it("rejects a real parent-traversal tar member before extraction", () => {
    const f = fixture();
    const header = Buffer.alloc(512);
    header.write("package/../escape");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write("00000000000\0", 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    fs.writeFileSync(f.archive, gzipSync(Buffer.concat([header, Buffer.alloc(1024)])));
    f.metadata.archiveSha256 = hash(fs.readFileSync(f.archive));
    f.save();
    const result = f.install();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unsafe archive member");
    expect(fs.existsSync(path.join(f.root, "escape"))).toBe(false);
  });

});
