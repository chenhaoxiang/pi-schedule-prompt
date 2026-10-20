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
- 安装入口：`pi install git:github.com/chenhaoxiang/pi-schedule-prompt@main`；需要复现时锁定受审提交。
- 要求 Node 22.19+、Pi 1.3.x。本次源码改动不自动安装、不强制重启旧会话、不启动真实监控。

## 定时与管理

可以直接要求“每十分钟检查当前已授权任务，最多十二次”或“三十分钟后提醒审查 PR”。Agent 使用 schedule_prompt 工具；支持 add/list/remove/enable/disable/update/cleanup。

- type=once：+30s、+5m 或绝对时间。
- type=interval：30s、5m、1h；受宿主最大计时范围限制。
- type=cron：六字段且包含秒，如 `0 */5 * * * *`；不接受五字段，使用进程时区。
- maxRuns：可选的终身尝试次数上限，不是 Token 或资金限额。
- expiresAt：可选绝对到期时间，在实际投递前再次检查。
- model：保留上游显式模型任务；notify 控制是否唤醒父会话，默认否；extensions/skills 可设 true 或名称列表，默认不加载。

/schedule-prompt 打开 Jobs 或 Settings。上下键选择，a 新增、t 启停、s 切作用域、x 删除、c 显式清理停用项、q 退出。暂停不等于删除，重载和退出不自动清理停用任务。

## 唤醒与状态

当前会话任务使用原生 scheduled_prompt custom turn，不伪造人类消息。会话忙碌时，同一任务重复到期只保留一次本地待执行记录；暂停、删除、重新调度或关闭会清除它。投递时重新读取最新内容、归属与限制。

- queued：本地待执行，尚未发起模型请求。
- dispatched：宿主接受投递，不等于已开工、业务成功或验收通过。
- running：显式模型任务运行中。
- success/error：显式模型任务返回结果或错误，不代替独立业务验收。
- unknown：中断或投递结果不明；先核对，不盲目重跑。

投递前的存储锁竞争保留一次待执行记录，稍后重试且不消耗尝试次数；结果不明的投递异常会暂停任务。暂停未来触发不能撤回已投递消息，也不能中止已经执行的工具。

## 多会话与存储

任务存于 cwd 下 .pi/schedule-prompts.json，新任务默认只绑定创建 session。其他 session 的绑定任务只读；共享任务明确向同目录每个 session 广播，可能重复执行，不应拿它选举总控。

存储采用互斥本地锁、唯一临时文件和原子替换；任务文件权限 0600，不写凭据。冲突立即报告，不阻塞会话；坏 JSON 不会被当空文件覆盖。崩溃遗留锁需先确认原写入者已退出，再处理该精确锁文件，不自动猜测接管。

设置按全局默认和项目覆盖合并；管理界面只写项目 widgetVisible/defaultJobScope。不自动改全局配置。运行中存储损坏会明确显示不可用，不把异常抛出界面刷新回调，也不覆盖原始文件。更新时省略限制参数会保留原值；需要去掉到期限制时可新建任务或将时间向后调整。

只有 Pi 正在运行才触发；离线周期不补跑，过期的一次性任务报错并停用。print/JSON 批处理不启动定时器。它不是常驻服务、操作系统唤醒器、权限系统或跨 session 目标管理器。

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

生命周期和本地事件共用准入；可选 GitHub 配置只读指定仓库/PR或工作流元数据，至少六十秒轮询。可选 eventApi 默认关闭，只监听回环地址，Token 由指定环境变量提供，HTTP 仅允许 api: 事件名。新状态写入版本2，旧运行时会拒绝，不要混用同一份状态文件。完整边界见 [事件准入](event-admission.md)。

## 开发与验证

执行 `npm ci --ignore-scripts --no-audit --no-fund`，再执行 `npm run check`。检查包含 lint、类型、有限并发无提供商回归和构建。真实 SDK 夹具使用内存 faux provider、隔离资源，不读取真实凭据或调用付费模型。

详细行为见 [可靠调度设计](reliable-scheduling.md)。
