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
  const hostScope = path.join(root, "host/@earendil-works");
  for (const name of ["pi-coding-agent", "pi-ai", "pi-tui"]) {
    const dir = path.join(hostScope, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@earendil-works/" + name, version: "1.3.0" }));
  }
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
    expect(receipt.hostPath).toBe(fs.realpathSync(path.join(f.root, "host/@earendil-works/pi-coding-agent")));
    expect(f.install().status).toBe(0);
    f.metadata.sourceSha = "b".repeat(40);
    f.save();
    expect(f.install().status).not.toBe(0);
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
    fs.writeFileSync(path.join(f.root, "host/@earendil-works/pi-ai/package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", version: "1.2.0" }));
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
