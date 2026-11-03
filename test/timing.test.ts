import { afterEach, describe, expect, it, vi } from "vitest";
import { resilientDefinition } from "../src/resilient-policy.js";
import { COOLDOWN_MS, cooldownNotBefore, misfire, nextCronOccurrence, nextDue, nextEligibleAfter, nextFixedDelay, nextFixedRate, occurrence, timingView } from "../src/timing.js";
import type { CronJob, ResilientPolicy } from "../src/types.js";

const at = (time: string) => Date.parse("2026-11-03T" + time + ".000Z");
function job(extra: Partial<CronJob> = {}, policy: Partial<ResilientPolicy> = {}) {
  const definition: CronJob = { id: "job", name: "job", type: "interval", schedule: "1h", intervalMs: 3_600_000, prompt: "synthetic", enabled: true, createdAt: "2026-11-03T10:00:00.000Z", runCount: 0, attemptCount: 0, session: "owner", maxRuns: 10, expiresAt: "2026-11-06T00:00:00.000Z", deadlineMs: 7_200_000, ...extra };
  return resilientDefinition(definition, { ...(definition.type === "interval" ? { intervalMode: "fixed-rate" as const } : { timezone: "UTC" }), latenessMs: 15 * 60_000, workBudgetMs: 6_000_000, ...policy });
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("pure resilient cadence and restoration", () => {
  it("fixed-rate starts at anchor+N and remains strictly anchored after long runs", () => {
    const anchor = "2026-11-03T10:00:00.000Z";
    expect(nextFixedRate(anchor, 3_600_000, at("10:00:00")).toISOString()).toBe("2026-11-03T11:00:00.000Z");
    expect(nextFixedRate(anchor, 3_600_000, at("11:20:00")).toISOString()).toBe("2026-11-03T12:00:00.000Z");
    expect(nextFixedRate(anchor, 3_600_000, at("11:00:00")).toISOString()).toBe("2026-11-03T12:00:00.000Z");
  });

  it("fixed-delay is relative to exact safe finish, and an overdue raw target is not rewritten to startup", () => {
    expect(nextFixedDelay("2026-11-03T11:20:00.000Z", 600_000, at("11:50:00")).toISOString()).toBe("2026-11-03T11:30:00.000Z");
    expect(nextFixedDelay(undefined, 600_000, at("11:20:00")).toISOString()).toBe("2026-11-03T11:30:00.000Z");
  });

  it("restoring repeatedly before a persisted completion-delay target never postpones it", () => {
    const current = job({ intervalMs: 600_000, schedule: "10m" }, { intervalMode: "fixed-delay" });
    current.runtime.lastFinishedAt = "2026-11-03T11:20:00.000Z";
    current.runtime.nextEligibleAt = "2026-11-03T11:30:00.000Z";
    expect(misfire(timingView(current), at("11:21:00"))).toMatchObject({ action: "future", dueAt: current.runtime.nextEligibleAt });
    expect(nextEligibleAfter(current, at("11:25:00"))?.toISOString()).toBe(current.runtime.nextEligibleAt);
  });

  it("skip restoration discards many missed ticks rather than rebuilding a backlog", () => {
    const view = { ...timingView(job()), nextEligibleAt: "2026-11-03T11:00:00.000Z" };
    expect(misfire(view, at("21:05:00"))).toMatchObject({ action: "skip", reason: "policy-skip" });
    expect(nextDue(view, at("21:05:00")).toISOString()).toBe("2026-11-03T22:00:00.000Z");
  });

  it("latest restoration selects only the latest anchored tick inside grace, not the first missed tick", () => {
    const view = { ...timingView(job({}, { misfirePolicy: "latest" })), nextEligibleAt: "2026-11-03T11:00:00.000Z" };
    expect(misfire(view, at("21:05:00"))).toEqual({ action: "eligible", dueAt: "2026-11-03T21:00:00.000Z", source: "misfire" });
    expect(misfire(view, at("21:16:00"))).toMatchObject({ action: "skip", reason: "outside-lateness" });
  });

  it("fixed-delay latest uses its one persisted target rather than inventing periodic ticks", () => {
    const current = job({ intervalMs: 600_000 }, { intervalMode: "fixed-delay", misfirePolicy: "latest" });
    current.runtime.lastFinishedAt = "2026-11-03T11:20:00.000Z";
    current.runtime.nextEligibleAt = "2026-11-03T11:50:00.000Z";
    expect(misfire(timingView(current), at("11:51:00"))).toEqual({ action: "eligible", dueAt: current.runtime.nextEligibleAt, source: "misfire" });
  });

  it("an on-time startup and a normal armed tick are not discarded by skip-misfire", () => {
    const view = { ...timingView(job()), nextEligibleAt: "2026-11-03T11:00:00.000Z" };
    expect(misfire(view, at("11:00:00"))).toMatchObject({ action: "eligible", source: "timer" });
    expect(occurrence(view, at("11:00:00") + 50)).toMatchObject({ dueAt: view.nextEligibleAt, source: "timer" });
  });

  it("a buffered live intent still expires by its own first due time", () => {
    const view = { ...timingView(job()), nextEligibleAt: "2026-11-03T11:00:00.000Z" };
    expect(() => occurrence(view, at("11:20:00"), "overlap")).toThrow(/outside lateness/);
    expect(() => occurrence(view, at("10:59:00"))).toThrow(/early/);
  });

  it("cron retains its explicit timezone when the process timezone changes", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    expect(nextCronOccurrence("0 0 9 * * *", "America/Los_Angeles", at("16:00:00")).toISOString()).toBe("2026-11-03T17:00:00.000Z");
    vi.stubEnv("TZ", "UTC");
    expect(nextCronOccurrence("0 0 9 * * *", "America/Los_Angeles", at("17:00:00")).toISOString()).toBe("2026-11-04T17:00:00.000Z");
  });

  it("cron latest recovers one calendar occurrence, not all missed days", () => {
    const current = job({ type: "cron", schedule: "0 0 * * * *", intervalMs: undefined }, { misfirePolicy: "latest" });
    current.runtime.nextEligibleAt = "2026-11-01T11:00:00.000Z";
    expect(misfire(timingView(current), at("21:05:00"))).toEqual({ action: "eligible", dueAt: "2026-11-03T21:00:00.000Z", source: "misfire" });
  });

  it("combines cooldown with future fixed-rate/cron ticks rather than running at an arbitrary cooldown end", () => {
    const rate = job(); rate.runtime.notBefore = "2026-11-03T11:30:00.000Z";
    expect(nextEligibleAfter(rate, at("11:00:00"))?.toISOString()).toBe("2026-11-03T12:00:00.000Z");
    rate.runtime.notBefore = "2026-11-03T12:00:00.000Z";
    expect(nextEligibleAfter(rate, at("11:00:00"))?.toISOString()).toBe("2026-11-03T12:00:00.000Z");
    const calendar = job({ type: "cron", schedule: "0 0 * * * *", intervalMs: undefined }); calendar.runtime.notBefore = "2026-11-03T11:30:00.000Z";
    expect(nextEligibleAfter(calendar, at("11:00:00"))?.toISOString()).toBe("2026-11-03T12:00:00.000Z");
  });

  it("combines completion delay and cooldown by maximum, not by adding a second delay", () => {
    const current = job({ intervalMs: 600_000 }, { intervalMode: "fixed-delay" });
    current.runtime.lastFinishedAt = "2026-11-03T11:20:00.000Z"; current.runtime.notBefore = "2026-11-03T11:40:00.000Z";
    expect(nextEligibleAfter(current, at("11:20:00"))?.toISOString()).toBe("2026-11-03T11:40:00.000Z");
  });

  it("UTC daily cap, original expiry and user stop remain stronger than timing eligibility", () => {
    const current = job({ attemptCount: 1, maxRunsPerDay: 1, dailyUsage: { day: "2026-11-03", attempts: 1 } });
    expect(nextEligibleAfter(current, at("11:00:00"))?.toISOString()).toBe("2026-11-04T00:00:00.000Z");
    current.expiresAt = "2026-11-04T00:00:00.000Z";
    expect(nextEligibleAfter(current, at("11:00:00"))).toBeUndefined();
    current.expiresAt = "2026-11-06T00:00:00.000Z"; current.enabled = false;
    expect(nextEligibleAfter(current, at("11:00:00"))).toBeUndefined();
  });

  it("clock rollback never creates a negative-rate catchup sequence", () => {
    expect(nextFixedRate("2026-11-03T10:00:00.000Z", 3_600_000, at("09:00:00")).toISOString()).toBe("2026-11-03T11:00:00.000Z");
  });

  it("uses finite capped cooldown and bounded persisted jitter without resetting spent retry time", () => {
    expect(COOLDOWN_MS.slice(1)).toEqual([60_000, 120_000, 300_000, 600_000, 1_800_000]);
    expect(Date.parse(cooldownNotBefore(at("10:00:00"), 5, 1000)) - at("10:00:00")).toBe(1_801_000);
    expect(cooldownNotBefore(at("10:00:00"), 99)).toBe("2026-11-03T10:30:00.000Z");
    expect(() => cooldownNotBefore(at("10:00:00"), 1, 60_001)).toThrow();
  });
});
