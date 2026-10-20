import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CronJob, CronStore } from "./types.js";

const STATUSES = new Set(["success", "error", "running", "queued", "dispatched", "unknown"]);

function validate(store: unknown): asserts store is CronStore {
  if (!store || typeof store !== "object") throw new Error("Invalid schedule store");
  const data = store as CronStore;
  if (data.version !== 1 || !Array.isArray(data.jobs)) throw new Error("Unsupported schedule store");
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const job of data.jobs) {
    if (!job || typeof job !== "object" ||
      ![job.id, job.name, job.schedule, job.prompt, job.createdAt].every(v => typeof v === "string" && v.trim()) ||
      !["cron", "interval", "once"].includes(job.type) || typeof job.enabled !== "boolean" ||
      !Number.isSafeInteger(job.runCount) || job.runCount < 0 ||
      (job.intervalMs !== undefined && (!Number.isSafeInteger(job.intervalMs) || job.intervalMs <= 0)) ||
      (job.session !== undefined && (typeof job.session !== "string" || !job.session.trim())) ||
      (job.model !== undefined && (typeof job.model !== "string" || !job.model.trim())) ||
      (job.lastStatus !== undefined && !STATUSES.has(job.lastStatus)) ||
      (job.attemptCount !== undefined && (!Number.isSafeInteger(job.attemptCount) || job.attemptCount < 0)) ||
      (job.maxRuns !== undefined && (!Number.isSafeInteger(job.maxRuns) || job.maxRuns < 1)) ||
      (job.expiresAt !== undefined && (typeof job.expiresAt !== "string" || !Number.isFinite(Date.parse(job.expiresAt))))) {
      throw new Error("Invalid scheduled job; refusing to overwrite the store");
    }
    if (ids.has(job.id) || names.has(job.name)) throw new Error("Duplicate scheduled job id or name");
    ids.add(job.id);
    names.add(job.name);
  }
}

/** Cooperating same-user local writers; not a distributed execution lock. */
export class CronStorage {
  private readonly storePath: string;
  private readonly piDir: string;

  constructor(cwd: string) {
    this.piDir = path.join(cwd, ".pi");
    this.storePath = path.join(this.piDir, "schedule-prompts.json");
  }

  load(): CronStore {
    let text: string;
    try {
      text = fs.readFileSync(this.storePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, jobs: [] };
      throw error;
    }
    const store: unknown = JSON.parse(text);
    validate(store);
    return store;
  }

  private mutate<T>(change: (store: CronStore) => T): T {
    fs.mkdirSync(this.piDir, { recursive: true, mode: 0o700 });
    const lockPath = `${this.storePath}.lock`;
    let fd: number;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Schedule store is busy (lock exists); retry after the owning writer finishes");
      }
      throw error;
    }
    const temporary = `${this.storePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      const store = this.load();
      const result = change(store);
      validate(store);
      const output = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(output, JSON.stringify(store, null, 2), "utf8");
        fs.fsyncSync(output);
      } finally {
        fs.closeSync(output);
      }
      fs.renameSync(temporary, this.storePath);
      return result;
    } finally {
      fs.rmSync(temporary, { force: true });
      fs.closeSync(fd);
      fs.rmSync(lockPath);
    }
  }

  /** Claim one attempt under the same mutation lock; this is not completion proof. */
  admitJob(id: string, sessionId: string | undefined): CronJob | undefined {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job?.enabled || (job.session && job.session !== sessionId)) return;
      if ((job.expiresAt && Date.parse(job.expiresAt) <= Date.now()) ||
        (job.maxRuns !== undefined && (job.attemptCount ?? job.runCount) >= job.maxRuns)) {
        job.enabled = false;
        return;
      }
      job.attemptCount = (job.attemptCount ?? job.runCount) + 1;
      job.lastStatus = "unknown";
      return { ...job };
    });
  }

  hasJobWithName(name: string): boolean {
    return this.load().jobs.some(job => job.name === name);
  }

  addJob(job: CronJob): void {
    this.mutate(store => {
      if (store.jobs.some(item => item.id === job.id || item.name === job.name)) {
        throw new Error("A scheduled job with this id or name already exists");
      }
      store.jobs.push(job);
    });
  }

  removeJob(id: string): boolean {
    return this.mutate(store => {
      const count = store.jobs.length;
      store.jobs = store.jobs.filter(job => job.id !== id);
      return store.jobs.length !== count;
    });
  }

  updateJob(id: string, partial: Partial<CronJob>): boolean {
    return this.mutate(store => {
      const job = store.jobs.find(item => item.id === id);
      if (!job) return false;
      Object.assign(job, partial);
      return true;
    });
  }

  getJob(id: string): CronJob | undefined {
    return this.load().jobs.find(job => job.id === id);
  }

  getAllJobs(): CronJob[] {
    return this.load().jobs;
  }

  getStorePath(): string {
    return this.storePath;
  }
}
