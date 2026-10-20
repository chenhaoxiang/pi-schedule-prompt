# Design

The maintained extension targets Pi 1.3 native custom turns and keeps one existing schedule store. A pending map is keyed by job id. Only an idle session with no pending host messages drains it; a short unref timer exists only while work is pending. Disable, remove, update and shutdown invalidate local pending work; dispatch re-reads disk so edits made by another session also take effect. No prompt is inserted into the host queue while it is busy.

Inline status ends at dispatched, not success: host acceptance is not start, completion or business verification. Interrupted observed model runs become unknown. Existing explicit model jobs remain available but are single-flight per local job; they are not a replacement for pi-subagents. Optional limits are checked again immediately before dispatch. Pausing/deleting future fires is distinct from cancellation of a currently executing tool.

Store mutations use an exclusive local lock and unique atomic replacement files, private file modes and validated records. Contention fails clearly instead of sleeping in the host or overwriting another writer; corrupt stores are not auto-replaced. This protects cooperating same-user local processes, not hostile filesystems or distributed side effects. Reads do not acquire an execution permit.

Pi lifecycle handlers reset the recursion guard using the actual before_agent_start source rather than inspecting a few historical messages. Session shutdown is idempotent and does not delete paused jobs. Raw prompts stay in the local task store and are not forwarded to Vista. A safe cron:change event remains observational.

Community master is captured unchanged in upstream-main. main receives maintained changes through PR. No package installation or release is implied by source/fixture acceptance.
