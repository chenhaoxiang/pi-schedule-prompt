import { request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startEventApi } from "../src/event-api.js";
import { validateGithub } from "../src/events.js";
import { githubFingerprint } from "../src/github-events.js";

const servers: Server[] = [];
const token = "synthetic-test-token-not-a-credential";
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function api(trigger = vi.fn(() => ({ status: "queued" as const })), requestsPerMinute = 60) {
  const server = await startEventApi({ port: 0, token, requestsPerMinute }, trigger); servers.push(server);
  const address = server.address() as { port: number; address: string };
  expect(address.address).toBe("127.0.0.1");
  const url = `http://127.0.0.1:${address.port}/events`;
  const request = (body: object, headers: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token, ...headers }, body: JSON.stringify(body) });
  return { request, trigger, url };
}
const data = { jobId: "job", eventName: "api:build", eventId: "fixture-1" };

describe("optional authenticated loopback events", () => {
  it("accepts only a small exact existing-task selector", async () => {
    const h = await api(); const response = await h.request(data);
    expect(response.status).toBe(202); expect(await response.json()).toEqual({ status: "queued" });
    expect(h.trigger).toHaveBeenCalledWith("job", "api:build", "fixture-1");
  });
  it("rejects missing/bad auth, foreign origin, unsafe Host and free-form instructions", async () => {
    const h = await api();
    expect((await h.request(data, { authorization: "" })).status).toBe(401);
    expect((await h.request(data, { origin: "https://untrusted.example" })).status).toBe(403);
    expect((await h.request({ ...data, prompt: "run an arbitrary command" })).status).toBe(400);
    expect((await h.request({ ...data, eventName: "lifecycle:session-start" })).status).toBe(400);
    const hostStatus = await new Promise(resolve => {
      const request = httpRequest(h.url, { method: "POST", headers: { host: "untrusted.example", "content-type": "application/json", authorization: "Bearer " + token } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      request.end(JSON.stringify(data));
    });
    expect(hostStatus).toBe(403);
    expect(h.trigger).not.toHaveBeenCalled();
  });
  it("bounds bodies/rate and does not claim paused work started", async () => {
    const h = await api(vi.fn(() => ({ status: "ignored" as any, reason: "paused" })), 2);
    expect((await h.request({ ...data, extra: "x".repeat(5000) })).status).toBe(413);
    expect((await h.request(data)).status).toBe(423);
    expect((await h.request(data)).status).toBe(429);
  });
  it("contains admission failure without exposing secrets", async () => {
    const h = await api(vi.fn(() => { throw new Error("synthetic private failure"); }));
    const response = await h.request(data);
    expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("private failure");
  });
});

describe("selected GitHub metadata only", () => {
  it("uses fixed GET argv and ignores PR body/comment instructions", async () => {
    const read = vi.fn(async () => ({ number: 12, state: "open", updated_at: "now", head: { sha: "abc" }, body: "malicious prompt" }));
    const one = await githubFingerprint({ repo: "owner/repo", kind: "pull-request", number: 12 }, read);
    read.mockResolvedValue({ number: 12, state: "open", updated_at: "now", head: { sha: "abc" }, body: "different text" });
    expect(await githubFingerprint({ repo: "owner/repo", kind: "pull-request", number: 12 }, read)).toBe(one);
    expect(read.mock.calls[0][0]).toEqual(["api", "--method", "GET", "repos/owner/repo/pulls/12"]);
  });
  it("observes workflow conclusion changes within the selected repository/branch", async () => {
    const read = vi.fn(async () => ({ workflow_runs: [{ id: 1, status: "in_progress", conclusion: null }] }));
    const config = { repo: "owner/repo", kind: "workflow" as const, branch: "main" };
    const first = await githubFingerprint(config, read);
    read.mockResolvedValue({ workflow_runs: [{ id: 1, status: "completed", conclusion: "success" as any }] });
    expect(await githubFingerprint(config, read)).not.toBe(first);
    expect(read.mock.calls[0][0][3]).toContain("branch=main");
  });
  it.each(["../repo", "owner/..", "owner/repo;command", "https://example/repo"])("rejects invalid repo %s before execution", repo => {
    expect(() => validateGithub({ repo, kind: "pull-request", number: 1 })).toThrow();
  });
  it("rejects malformed workflow/PR identity responses", async () => {
    await expect(githubFingerprint({ repo: "owner/repo", kind: "workflow" }, async () => ({}))).rejects.toThrow();
    await expect(githubFingerprint({ repo: "owner/repo", kind: "pull-request", number: 1 }, async () => ({ number: 2 }))).rejects.toThrow();
  });
});
