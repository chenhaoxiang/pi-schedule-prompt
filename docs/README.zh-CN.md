---
doc_type: guide
project: pi-schedule-prompt
status: active
truth_mode: maintained
created: 2026-10-20
---

# Pi Schedule Prompt 维护版

[English](../README.md) | 简体中文

本仓为 chenhaoxiang/pi-schedule-prompt，基于 tintinweb/pi-schedule-prompt 0.4.1 维护，保留 MIT 许可和原作者署名。

## 分支与安装

- main：经过审查的维护整合主线。
- upstream-main：纯社区镜像，不作为安装源；upstream 远端只读。
- 版本使用 0.4.1-fork.N，禁止误发至社区 npm 身份。源码、GitHub Release、本机安装和运行中的 session 分别验真。
- 安装入口：`pi install git:github.com/chenhaoxiang/pi-schedule-prompt@v0.4.1-fork.22`；需要复现时锁定受审提交。
- 要求 Node 22.19+、Pi 1.3.x。本次源码改动不自动安装、不强制重启旧会话、不启动真实监控。

## 定时与管理

可以直接要求“每十分钟检查当前已授权任务，最多十二次”或“三十分钟后提醒审查 PR”。Agent 使用 schedule_prompt 工具；支持 add/list/remove/enable/disable/update/cleanup。

- type=once：+30s、+5m 或绝对时间。
- type=interval：30s、5m、1h；受宿主最大计时范围限制。
- type=cron：六字段且包含秒，如 `0 */5 * * * *`；不接受五字段，使用进程时区。
- maxRuns：可选的终身尝试次数上限，不是 Token 或资金限额。
- expiresAt：可选绝对到期时间，在实际投递前再次检查。
- model：显式模型任务。创建或更新时会按当前已配置凭据的模型注册表做前置解析，并保存完整的 `provider/model-id` 路由；裸模型名仅在唯一匹配时接受，未知或跨 provider 歧义会在调度建立前拒绝。运行前还会再次核验。notify 控制是否唤醒父会话，默认否；extensions/skills 可设 true 或名称列表，默认不加载。

/schedule-prompt 打开 Jobs 或 Settings。上下键选择，a 新增、t 启停、s 切作用域、x 删除、c 显式清理停用项、q 退出。暂停不等于删除，重载和退出不自动清理停用任务。

## 唤醒与状态

当前会话任务使用原生 scheduled_prompt custom turn，不伪造人类消息。会话忙碌时，同一任务重复到期只保留一次本地待执行记录；暂停、删除、重新调度或关闭会清除它。投递时重新读取最新内容、归属与限制。

- queued：本地待执行，尚未发起模型请求。
- dispatched：宿主接受投递，不等于已开工、业务成功或验收通过。
- running：显式模型任务运行中。
- success/error：显式模型任务返回结果或错误，不代替独立业务验收。
- unknown：中断或投递结果不明；先核对，不盲目重跑。

投递前的存储锁竞争保留一次待执行记录，稍后重试且不消耗尝试次数；结果不明的投递异常会暂停任务。暂停未来触发不能撤回已投递消息，也不能中止已经执行的工具。

**0.4.1-fork.20** 修复了独立模型任务被父会话忙碌或待处理消息挡住的问题，覆盖计时、事件、durable 和 resilient 路径；排在前面的内联任务不会拖住后面的独立模型任务。内联任务仍等待父会话空闲，原单次在途、归属、次数/到期、UNKNOWN 和 SDK 关闭确认不变。未请求通知的旧式模型状态标记会保留，但不插入父会话的执行流程或增加请求；显式 `notify:true` 的完成跟进行为保留。子任务启动记录写入失败时只取消该子任务，不中止无关父任务。本次不迁移真实任务存储、不强制重载活动会话。

## 对账后按节奏续接

**0.4.1-fork.21** 新增精确 native attempt 的 `resolution:"continue-delayed"`，必须配 `resumeAfterMs`（1000–86400000毫秒）。例如3600000表示从首次记录该证据的时刻起至少等一小时，再按原 cadence 及更强的供应商冷却、每日/总次数、到期和副作用门禁调度；fixed-rate 可能等待更后的锚点。重试、重启不续长等待，不重置花费或原 UNKNOWN。暂停时可记录延迟对账，但仍须显式 enable 才允许未来执行。

普通 `continue` 仍是立即接续 checkpoint；`schedule` 仅属于 add/update，在 reconcile 中会明确拒绝，不再静默忽略。先用现有 status 核实实际 loaded 的 `runtime.loadedSchedule.reconcileDelayedVersion:1`，不能从磁盘安装推断。旧工具会拒绝新 resolution；状态格式仍为 schema4，但不能据此混用未经验证的旧调度写入者执行延迟任务。当前 hold/恢复保留屏障，投影丢失时仍从不可变 resolution 重建最小等待并在准入处检查，不迁移真实任务或强 reload。例子与边界见[可靠调度设计](reliable-scheduling.md#delayed-native-continuation)。

## 已过期模型任务退役

fork.22 提供独立的[显式维护 CLI](reliable-scheduling.md#expired-model-job-retirement)，供用户已明确授权、原交互 owner 已退休的精确任务退役。它只处理已到期、idle、无 pending 且原 native/SDK 关闭证据可回读的模型任务；先只读预览，apply 绑定存储 SHA-256 并沿既有锁备份后仅关闭 enabled。UNKNOWN、执行历史、owner 和预算不变，不启动 SDK、不唤醒旧会话、不恢复或重放动作。普通 session 管理工具仍不能修改其他 owner 的任务；不支持的在途、legacy 或不完整证据场景保持拒绝。

## 多会话与存储

任务存于 cwd 下 .pi/schedule-prompts.json，新任务默认只绑定创建 session。其他 session 的绑定任务只读；共享任务明确向同目录每个 session 广播，可能重复执行，不应拿它选举总控。

存储采用互斥本地锁、唯一临时文件和原子替换；任务文件权限 0600，不写凭据。冲突立即报告，不阻塞会话；坏 JSON 不会被当空文件覆盖。崩溃遗留锁需先确认原写入者已退出，再处理该精确锁文件，不自动猜测接管。

设置按全局默认和项目覆盖合并；管理界面只写项目 widgetVisible/defaultJobScope。不自动改全局配置。运行中存储损坏会明确显示不可用，不把异常抛出界面刷新回调，也不覆盖原始文件。更新时省略限制参数会保留原值；需要去掉到期限制时可新建任务或将时间向后调整。

只有兼容的 Pi 正在运行才触发；传统任务离线不补跑，过期的一次性任务报错停用。print/JSON 批处理不启动定时器。下方的可选专用宿主可常驻自己的 Pi，但不授予新权限、不接管任意终端，也不保证唤醒休眠的操作系统。

## 与既有组件组合

- 原会话定时唤醒：本扩展。
- 已存在 session 的定向沟通：Intercom。
- 隔离子任务、工作流、恢复：pi-subagents。
- 已在 Crew 管理的依赖：Messenger；不复制第二份状态。
- Vista 仅消费脱敏观察，不承担执行许可或调度控制。

同一周期任务只能由一个调度器负责。显式 model 模式仍可启动有工具能力的新会话，不是沙箱；默认工具包括 bash/read/edit/write/grep/find/ls，默认不加载扩展/技能，显式启用时需审阅对应能力。

## 总控与后续路线

`/supervise` 提供有限范围的监督提示模板，复用现有 Intercom/Subagents 工具；必须明确目标会话、仓库、已有目标/证据来源及次数/到期限制，不会自动接管全部会话。运行与真实试点边界见 [在线总控](online-supervision.md)，事件与常驻阶段见 [统一路线](automation-roadmap.md)。

## 事件触发与每日限制

新增 `type:event`，schedule 填最多四个逗号分隔事件名；任务必须绑定 session。`action:trigger` 只接受既有 jobId、eventName 和稳定 eventId，不能由事件提供新提示或命令。`maxRunsPerDay` 按 UTC 日历日限制已准入尝试，catchUp 明确选 none 或 latest。

生命周期和本地事件共用准入；可选 GitHub 配置只读指定仓库/PR或工作流元数据，至少六十秒轮询。新增显式 `github:{repo,kind:"pull-request-checks",number}` 配合事件名 `github:pull-request-checks`，观察该PR当前精确head的check runs与旧式commit statuses；首次有效快照也通知原负责人对账一次，避免注册时CI已完成却一直等待；之后相同证据保持安静。评论、输出正文和无关workflow不会进入指纹。PR读取期间head/base变化、集合不完整或超限时不发布结果，沿现有退避处理；原负责人仍须重新核对适用审查、CI和权限，事件不代表可以合并。旧PR/workflow模式不变；旧运行时拒绝新selector，不得混用该任务存储。可选 eventApi 默认关闭，只监听回环地址，Token 由指定环境变量提供，HTTP 仅允许 api: 事件名。本版新状态写入版本3，可读版本1/2/3；旧运行时会拒绝新格式，不要混用同一份状态文件。完整边界见 [事件准入](event-admission.md)。

## 可选常驻与恢复

绑定会话的任务可显式设 `durable:true`；`deadlineMs` 为1秒至24小时，默认10分钟。时间与事件意图先落盘，领取后关联唯一 claim、原生会话收据和单独的通知状态。重启只恢复明确未派发的工作；可能已产生作用但缺少收据的任务标为 unknown 并暂停，不自动重跑。三个连续确认错误会停用，截止时间只中止本宿主/进程内执行，不代表撤回外部影响。

固定包提供 `scripts/supervisor.mjs run|status|stop|plist /私有配置.json`。它只管理自己创建的原生 Pi RPC 子进程，保留宿主守卫、扩展及凭据路径；服务任务必须有 maxRuns 和 expiresAt。控制入口仅回环、带鉴权，只允许状态与停止；停止返回前确认自有进程退出。`plist` 仅输出可选 LaunchAgent 配置，不自动安装或开机运行。未指定真实目标时保持零任务，详见 [常驻监督运行说明](durable-supervisor.md)。

## 开发与验证

执行 `npm ci --ignore-scripts --no-audit --no-fund`，再执行 `npm run check`。检查包含 lint、类型、有限并发无提供商回归和构建。真实 SDK 夹具使用内存 faux provider、隔离资源，不读取真实凭据或调用付费模型。

详细行为见 [可靠调度设计](reliable-scheduling.md)。
