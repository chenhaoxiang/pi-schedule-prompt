import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { validEventId, validEventName, validEvidenceFingerprint } from "./events.js";
import type { EventResult } from "./types.js";

export interface EventApiOptions { port: number; token: string; requestsPerMinute?: number; }
export function startEventApi(options: EventApiOptions,
  trigger: (jobId: string, name: string, id: string, evidenceFingerprint?: string) => EventResult): Promise<Server> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535 || options.token.length < 24) {
    throw new Error("Event API requires an explicit valid port and token of at least 24 characters");
  }
  const secret = createHash("sha256").update(options.token).digest();
  let window = Date.now();
  let count = 0;
  const server = createServer(async (request, response) => {
    const reply = (status: number, body: object) => {
      if (response.writableEnded || response.destroyed || response.headersSent) return;
      try { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); }
      catch { response.destroy(); }
    };
    try {
      const address = request.socket.remoteAddress;
      const host = request.headers.host;
      const port = (server.address() as { port: number }).port;
      if (address !== "127.0.0.1" || !["127.0.0.1:" + port, "localhost:" + port].includes(host ?? "")) return reply(403, { error: "loopback-only" });
      if (request.headers.origin && !["http://127.0.0.1:" + port, "http://localhost:" + port].includes(request.headers.origin)) return reply(403, { error: "origin-denied" });
      if (request.method !== "POST" || request.url !== "/events") return reply(404, { error: "not-found" });
      if (Date.now() - window >= 60000) { window = Date.now(); count = 0; }
      if (++count > (options.requestsPerMinute ?? 60)) return reply(429, { error: "rate-limit" });
      const authorization = request.headers.authorization ?? "";
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!timingSafeEqual(createHash("sha256").update(token).digest(), secret)) return reply(401, { error: "unauthorized" });
      if (request.headers["content-type"] !== "application/json") return reply(415, { error: "json-required" });
      if (Number(request.headers["content-length"] ?? 0) > 4096) { request.resume(); return reply(413, { error: "too-large" }); }
      let text = "";
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        text += chunk;
        if (Buffer.byteLength(text) > 4096) { request.resume(); return reply(413, { error: "too-large" }); }
      }
      let data: unknown;
      try { data = JSON.parse(text); } catch { return reply(400, { error: "invalid-json" }); }
      if (!data || typeof data !== "object" || Array.isArray(data)) return reply(400, { error: "invalid-event" });
      const body = data as Record<string, unknown>;
      if (Object.keys(body).some(key => !["jobId", "eventName", "eventId", "evidenceFingerprint"].includes(key)) ||
        typeof body.jobId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.jobId) ||
        !validEventName(body.eventName) || !body.eventName.startsWith("api:") || !validEventId(body.eventId) ||
        (body.evidenceFingerprint !== undefined && !validEvidenceFingerprint(body.evidenceFingerprint))) return reply(400, { error: "invalid-event" });
      const result = body.evidenceFingerprint === undefined
        ? trigger(body.jobId, body.eventName, body.eventId)
        : trigger(body.jobId, body.eventName, body.eventId, body.evidenceFingerprint);
      return reply(result.status === "ignored" ? 423 : 202, result);
    } catch { reply(503, { error: "admission-unavailable" }); }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.timeout = 5000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      server.on("error", () => console.error("Local event API unavailable"));
      resolve(server);
    });
  });
}
