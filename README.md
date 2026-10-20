# Pi Schedule Prompt — maintained fork

English | [简体中文](docs/README.zh-CN.md)

Timed prompts for Pi 1.3: recurring cron/interval jobs and one-shot reminders, with session binding, native custom turns and a local management UI.

This is [chenhaoxiang/pi-schedule-prompt](https://github.com/chenhaoxiang/pi-schedule-prompt), maintained from [tintinweb/pi-schedule-prompt](https://github.com/tintinweb/pi-schedule-prompt). The upstream MIT license and attribution are retained.

## Branches and installation

- `main`: reviewed maintenance/integration line.
- `upstream-main`: exact community mirror, never an installation source.
- `upstream`: fetch-only community remote; its push URL is disabled.
- Fork versions use `0.4.1-fork.N`. Source delivery is separate from a GitHub Release or local installation. This package is private-to-npm to prevent publication under the community identity.

Install the maintained source only after reviewing its changes:

```sh
pi install git:github.com/chenhaoxiang/pi-schedule-prompt@main
```

Pin a reviewed commit for reproducibility. Installation does not hot-upgrade active Pi sessions. This change does not install itself or start monitoring other sessions.

Requirements: Node 22.19+ and Pi 1.3.x. Host SDK packages are peers, not bundled copies.

## Create and manage jobs

Ask the agent naturally:

- “Check this authorized task every 10 minutes, at most 12 attempts.”
- “Remind me to review the PR in 30 minutes.”
- “Run this check on weekdays at 9:00.”

The agent uses `schedule_prompt`. Actions: `add`, `list`, `remove`, `enable`, `disable`, `update`, `cleanup`.

| Parameter | Meaning |
| --- | --- |
| `action` | Operation; required |
| `name` | Unique display name; generated when omitted |
| `type` | `cron` (default), `interval`, or `once` |
| `schedule` | Required on add: six-field cron, interval or one-shot time |
| `prompt` | Required on add; the authorized work to request |
| `jobId` | Required for remove/enable/disable/update |
| `description` | Optional local note |
| `maxRuns` | Optional positive lifetime attempt cap; not tokens or money |
| `expiresAt` | Optional absolute future timestamp; re-checked before dispatch |
| `model` | Explicit model-job mode; see below |
| `notify` | Model-job only; wake parent on completion, default false |
| `extensions`, `skills` | Model-job only: true or a name list; default none |

Omitting limits on update preserves them; to remove an expiry, replace the job or move the timestamp forward.

Schedule formats:

| Type | Examples |
| --- | --- |
| Once | `+30s`, `+5m`, `2026-12-01T09:00:00Z` |
| Interval | `30s`, `5m`, `1h` |
| Cron, with seconds | `0 */5 * * * *`, `0 0 9 * * 1-5` |

Five-field cron is not accepted. Intervals are bounded by the host timer range (2147483647 ms); long one-shot waits are re-armed in bounded chunks. Cron uses the process timezone.

`/schedule-prompt` opens Jobs and Settings. Jobs hotkeys: arrows select, `a` add, `t` enable/disable, `s` scope, `x` remove, `c` explicitly clean disabled jobs, `q` exit. Paused jobs survive shutdown and reload; cleanup is never automatic. Other sessions' bound jobs are read-only.

## Native dispatch and status

Inline jobs send one `scheduled_prompt` custom message, not a synthetic human message. While Pi is busy or has pending messages, repeated fires for one job collapse into one local pending entry. Disable/remove/reschedule/shutdown discard that entry. The latest stored prompt, ownership and limits are checked again before dispatch.

| Status | What it proves |
| --- | --- |
| `queued` | One local pending fire; no model request yet |
| `dispatched` | Host accepted an inline custom message; not task completion |
| `running` | An explicit model job is in progress |
| `success` / `error` | Explicit model run returned a result/error; not independent business verification |
| `unknown` | Interrupted work or ambiguous delivery; reconcile before resuming |

Pre-admission store contention retains one pending intent and retries without consuming an attempt. Ambiguous sends are paused, not blindly retried. Disabling a schedule cannot retract an already delivered prompt or cancel an active tool. This is not an exactly-once guarantee.

## Scope, persistence and safety

Jobs live in `<cwd>/.pi/schedule-prompts.json`. New jobs bind to the creating session by default. Unbound/shared jobs deliberately broadcast to every Pi in that cwd; do not use shared mode to elect a supervisor. Storage serialization protects cooperating writers, not single execution of shared jobs.

Mutations use an exclusive local lock and unique atomic replacements. Task files use mode 0600; prompts must not contain secrets. Corrupt stores are not replaced with an empty file. Contention fails visibly instead of blocking Pi. A leftover lock after a crash requires confirming the writer is gone before removing that exact lock. This is a same-user/local-filesystem contract, not adversarial or NFS isolation.

Settings merge global `~/.pi/agent/schedule-prompts-settings.json` defaults with project `.pi/schedule-prompts-settings.json`. The UI only writes project settings: `widgetVisible` and `defaultJobScope` (session/workdir). Runtime store faults display an unavailable state without escaping UI refresh callbacks or replacing corrupt bytes.

Schedules fire only in a compatible live Pi session. Offline ticks are not replayed; past one-shots are disabled with an error. Print/JSON batch sessions do not arm timers. This is not a daemon, OS wake service, permission system or cross-session supervisor.

## Explicit model jobs

The upstream `model` option remains available: it creates a fresh in-process session. Default tools are bash/read/edit/write/grep/find/ls, with no extensions or skills. Explicit options can load additional resources and the default host toolset. Provider-qualified fuzzy requests never switch provider. Current host provider configuration is inherited where available, thinking level is preserved, overlapping runs for one local job are suppressed, and sessions are disposed afterward. These are powerful unattended jobs, not a sandbox.

For our composed setup, prefer inline waking of the owning session, Intercom for existing peers and pi-subagents for independent workflows/worktrees. Do not register the same recurring job in both schedulers. A persisted schedule does not extend authorization.

## Composed supervision rollout

`/supervise` is a packaged bounded supervision recipe using the existing Intercom/Subagents tools. It requires exact selected peers, existing goal/evidence references and finite check/expiry limits; it does not automatically control other sessions. See [online operation](docs/online-supervision.md) and the [single overall roadmap](docs/automation-roadmap.md) for online, event and durable stages.

## Event jobs and daily limits

Stage C adds session-bound `type: "event"` jobs. `schedule` is 1–4 comma-separated event names (for example `local:build,lifecycle:agent-settled`), not a cron expression. `action: "trigger"` requires `jobId`, `eventName`, and a stable `eventId`; it cannot inject a new prompt. `maxRunsPerDay` bounds UTC-calendar admission attempts, and `catchUp: "none" | "latest"` explicitly controls pending-event restoration. Configured model jobs use the same caps.

Optional `github` selects `{repo, kind: "pull-request", number}` or `{repo, kind: "workflow", branch?}` with at least60 seconds between metadata-only GET polls. It is off unless the task explicitly configures it. Optional project `eventApi: {enabled:true,port,tokenEnv}` binds only127.0.0.1 and requires a separately supplied bearer token; POST `/events` accepts only `{jobId,eventName,eventId}`, and HTTP names must start with `api:`. No listener starts by default.

See [event admission](docs/event-admission.md) for version2 storage, dedup bounds, source restrictions, expiry/pause and evidence limits. These are not hard financial budgets or live external-source acceptance.

## Development and verification

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
mkdir -p tmp
npm pack --ignore-scripts --pack-destination tmp
```

The check runs lint, typecheck, provider-free tests with bounded workers, and build. A real Pi lifecycle fixture uses an in-memory faux provider and isolated resources, not real credentials or paid inference. Source, installed-host fixtures, releases, installation and live activation remain distinct.

See [reliability design](docs/reliable-scheduling.md) and [the scoped OpenSpec change](openspec/changes/reliable-prompt-scheduling/).

## License

MIT. Original author: [tintinweb](https://github.com/tintinweb). Maintained fork: chenhaoxiang.
