import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const owned: string[] = [];
afterEach(() => { for (const dir of owned.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("fixed pack npm JSON compatibility", () => {
  it.each(["array", "keyed", "multiple", "wrong-package"])("handles %s npm output without weakening provenance", shape => {
    const base = path.resolve("tmp/fixed-pack-fixtures"); fs.mkdirSync(base, { recursive: true });
    const root = fs.mkdtempSync(path.join(base, "case-")); owned.push(root);
    fs.mkdirSync(path.join(root, "scripts")); fs.mkdirSync(path.join(root, "bin")); fs.mkdirSync(path.join(root, "dist"));
    fs.copyFileSync(process.env.PI_SCHEDULE_PACK_TEST_SOURCE ?? "scripts/pack-fixed.mjs", path.join(root, "scripts/pack-fixed.mjs"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pi-schedule-prompt", version: "0.4.1-fork.99", type: "module", dependencies: {} }));
    fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ packages: {} }));
    const packed = { name: shape === "wrong-package" ? "foreign-package" : "pi-schedule-prompt", version: "0.4.1-fork.99", filename: "fixture.tgz", files: [{ path: "package.json", size: 1 }, { path: "dist/runtime-lock.json", size: 1 }] };
    const response = shape === "array" ? [packed] : shape === "multiple" ? { one: packed, two: packed } : { [packed.name]: packed };
    fs.writeFileSync(path.join(root, "response.json"), JSON.stringify(response));
    fs.writeFileSync(path.join(root, "bin/git"), "#!/bin/sh\ncase \"$3\" in status) exit 0;; rev-parse) printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;; *) exit 2;; esac\n", { mode: 0o700 });
    const npm = `#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';const a=process.argv.slice(2);if(a[0]==='run')process.exit(0);if(a[0]!=='pack')process.exit(2);const out=a[a.indexOf('--pack-destination')+1];fs.writeFileSync(path.join(out,'fixture.tgz'),'synthetic archive');process.stdout.write(fs.readFileSync(path.join(${JSON.stringify(root)},'response.json')));\n`;
    fs.writeFileSync(path.join(root, "bin/npm"), npm, { mode: 0o700 });
    const out = path.join(root, "out");
    const run = spawnSync(process.execPath, [path.join(root, "scripts/pack-fixed.mjs"), out], { encoding: "utf8", env: { PATH: path.join(root, "bin") + path.delimiter + process.env.PATH, HOME: root }, timeout: 15000 });
    const expected = ["array", "keyed"].includes(shape);
    expect(run.status === 0, run.stderr).toBe(expected);
    const provenance = path.join(out, "pi-schedule-prompt-0.4.1-fork.99.provenance.json");
    expect(fs.existsSync(provenance)).toBe(expected);
    if (expected) expect(JSON.parse(fs.readFileSync(provenance, "utf8"))).toMatchObject({ sourceSha: "a".repeat(40), name: "pi-schedule-prompt", version: "0.4.1-fork.99", archive: "fixture.tgz" });
  });
});
