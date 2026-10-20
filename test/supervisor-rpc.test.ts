import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Packaged helper is deliberately dependency-free ESM.
import { NativeRpc } from "../scripts/supervisor-rpc.mjs";

const owned: string[] = [];
const children: any[] = [];
function child(source: string) {
  const base = path.resolve("tmp/rpc-transport-fixtures"); fs.mkdirSync(base, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(base, "case-")); owned.push(cwd);
  const file = path.join(cwd, "native.mjs"); fs.writeFileSync(file, source);
  const rpc = new NativeRpc(process.execPath, [file], { cwd, env: {}, onExit: () => {} }); children.push(rpc); return rpc;
}
afterEach(async () => { for (const rpc of children.splice(0)) await rpc.close(50); for (const cwd of owned.splice(0)) fs.rmSync(cwd, { recursive: true, force: true }); });

describe("bounded owned RPC transport", () => {
  it("splits only LF and preserves JSON U+2028/U+2029 string content", async () => {
    const rpc = child(`let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\\n'))!==-1){const request=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);process.stdout.write(JSON.stringify({type:'response',id:request.id,success:true,data:{text:'a\u2028b\u2029c'}})+'\\n');}});process.stdin.on('end',()=>process.exit(0));`);
    expect(await rpc.request("get_state")).toEqual({ text: "a\u2028b\u2029c" });
  });
  it("does not mistake command acceptance for completion and bounds timeout", async () => {
    const rpc = child(`process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`);
    await expect(rpc.request("get_state", {}, 30)).rejects.toThrow(/timed out/);
    expect(rpc.pending.size).toBe(0);
  });
  it("does not forward or retain raw stderr and rejects pending work on process loss", async () => {
    const rpc = child(`process.stderr.write('SYNTHETIC_PRIVATE_BODY');setTimeout(()=>process.exit(1),50);`);
    await expect(rpc.request("get_state")).rejects.toThrow(/unavailable/);
    expect(rpc.stderrBytes).toBeGreaterThan(0); expect(rpc.stderr).toBeUndefined();
  });
});
