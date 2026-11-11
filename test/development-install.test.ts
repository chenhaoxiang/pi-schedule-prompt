import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("source-only npm12 development policy", () => {
  it("permits root-declared URLs only, with no credential, lifecycle, registry or global-policy override", () => {
    const active = fs.readFileSync(".npmrc", "utf8").split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"));
    expect(active).toEqual(["allow-remote=root"]);
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    expect(pkg.files).not.toContain(".npmrc");
  });

  it("keeps the one approved direct remote dependency at its exact commit and lock integrity", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
    const direct = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([, value]) => /^https?:\/\//.test(String(value)));
    expect(direct).toHaveLength(1);
    const [name, url] = direct[0];
    expect(name).toBe("pi-intercom");
    expect(url).toMatch(/^https:\/\/codeload\.github\.com\/chenhaoxiang\/pi-intercom\/tar\.gz\/[a-f0-9]{40}$/);
    expect(lock.packages["node_modules/" + name]).toMatchObject({ resolved: url, dev: true });
    expect(lock.packages["node_modules/" + name].integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
    expect(lock.packages[""].devDependencies[name]).toBe(url);
  });
});
