# 第 20 段：可选宿主的活动、交互、队列与文件

2026-11-15。第 19 段已本地提交为 `10b6443`。本段保持未提交，未推送、发布或新增测试工程。

## 独立可使用的增量

可选宿主通过官方 Dock SDK 接收真实公开事件、原生审批／表单请求、steer 与 cancel，原运行结束后收回输出。新 `dock-runtime.mjs` 可以由宿主直接运行，也导出 `runExecution({ permissionHandler })` 给可信调用方保留自己的审批策略；HTTP 调用方不能选择该处理器的代码或路径。原生权限默认值不改变。

此能力不依赖 hutian-world、业务 PostgreSQL 或 DBOS。现有独立 Matrix 安装与 Dock 应用连接即可使用；通信核心没有加入 Dock 或业务模型依赖。新增 Dock 客户端仅是可选 examples 宿主的开发依赖。

```sh
pnpm install
pnpm web
```

示例网页仍保留原来的人工选择消息回复流程。消费新增能力的应用先发真实 Matrix 消息，再调用本机 `/api/agent`，在 context 中明确传 `interactive: true`、`executionMode: "task"` 与 bounded `timeoutMs`；可使用宿主默认设备或传已授权 node/provider。当前 hutian-world 页面已完整消费该契约；示例网页本轮未复制一套新的聊天 UI。

| 接口 | 含义 |
| --- | --- |
| `GET /api/state?roomId=...&cursor=...` | 授权房间快照、游标历史、原 job、活动、队列及回复关联 |
| `GET /api/agent/status` | 按原 source/agent 观察，包含被取消的排队项；不受最近历史窗口影响 |
| `POST /api/agent/control` | 稳定 operationId，原 runId，steer／stop／respond；同 ID 不同内容拒绝 |
| `POST /api/agent/queue` | 明确开始暂停项或移除项；保留取消记录 |
| `POST /api/uploads`、`GET /api/input` | Matrix 原生媒体、来源消息与 SHA-256，最多 8 MiB／份 |
| `GET /api/agent/output` | 只读取原 job 已收回的 output，返回元信息与内容 |
| `POST /api/agent/outputs/retrieve` | 只向原设备／原 run 补取成果；不调用 prepare 或 execute |

变更请求必须来自当前回环 Origin 并使用 JSON；接口逐次检查 Matrix 成员、自己发送的原消息、目标 Agent 与原运行。它是单操作者本机宿主接口，不是多人公网认证 API。

## 运行与故障规则

Runtime 只读查询使用 `/api/runtime?clientId=...&nodeId=...`，只允许当前宿主配置的应用身份。空闲读取与执行共享连接锁；运行中通过原 SDK 连接处理私有查询文件，不再开第二条同身份连接。接口只调用公开 inventory，不执行原生工作，也不接受凭据、路径、模型或权限变更。旧运行若没有查询代理则明确返回待刷新，不以“未配置”代替连接占用。

宿主先保留原 job/receipt、连接与设定快照，独立子进程持有 Dock 连接。活动按原事件保存到私有 job 目录，最多 300 条并标记截断，原最终回复与 outputs 单独保留。模型私有推理不进入公开活动。

原生支持时，同角色同房间沿兼容 session 接着工作；保存真正 native session ID 与 prior run，不能用应用 key 假冒原生 ID。任务端应用可选择不延续 session。宿主或设备未知故障仍只观察原回执，不用新运行掩盖。

宿主保持原单入口串行限制。入口忙时，interactive 请求保存本机持久队列；同会话前序停止、失败或未知则暂停，用户明确开始才能继续。取消项由 status 明确返回，调用方不得将其重新当成无 job 的待派发工作。独立会话不因另一会话停止而永久暂停。

控制命令先落私有原子文件，再由实际 SDK 连接处理。提交不等于原生接收；审批实际送达通过 permissionDelivered 核对。补充同时用稳定 Matrix transaction ID 保存为人类消息。终态请求失效；原 job 的确认终态覆盖陈旧活动状态，不编造结束时间。

原输出收回失败与原运行状态分开。补取时校验原 client/node/run，复用原连接凭据并取得已有连接锁；只能 collect，不能再次 execute。已收回内容可在原设备离线后读取，但并非整台设备文件同步。

## 实际验证

TypeScript、SDK build 和 Vite build；真实工作公开活动、拒绝、允许一次、文件回流、补充、停止、暂停后明确继续，以及两位 Agent 的引用交接，均通过 hutian 消费该独立宿主接口完成。Web、API 和 Matrix HTTP 入口重启后仍观察同一原生 run。记载了早期 session ID 修正和一次审批等待超时；没有重发该未知原工作。

这是 SDK/宿主能力的真实集成验证，不是再次执行全部干净安装或任意 Dock 故障恢复验证。原始证据在工作区私有目录；对外发布前另做相应目标版本验收。

待发布草稿：“让 Matrix 里的 Agent 真正工作：可选宿主接入已有 Dock SDK，回传公开活动、原生审批和真实文件，支持补充、停止和持久串行排队。核心仍只是独立通信 SDK；没有引入业务世界或自动编排。”

## 下午配套：原生点名与执行设置

通信消息可带 `mentionedUserIds`，按 Matrix `m.mentions.user_ids` 写入；HTTP 示例入口接受已加入的 Agent 标识，服务端映射为通信身份，不通过显示名称猜测。该元数据不自动触发执行，是否派发仍由宿主应用明确调用决定。

可选宿主保存并透传请求中的 `model` 和白名单 `config`（effort／serviceTier）；请求、持久队列、job 和 Dock receipt 保持同一快照。会话复用键加入这些设置，防止新模型／等级继续使用不兼容的旧原生 session。宿主只保证传递，不把上游发现能力等同于设备实际应用；本轮 Hutian 只开放已核对的 Codex model／effort，服务档位不开放修改。

通过 hutian-world 真实 UI 点名 Mac 与 Windows 两位成员，分别以 Astra/low、Sol/medium 完成原生平台命令。排队后修改会话配置，排队工作仍以原 Astra/low 执行；停止、补充和原消息派发恢复沿原标识完成。实际证据在根 `.local/composer-config-20261115/`，详情见 Hutian 当日验收记录。Matrix 类型检查已通过；独立示例网页未复制 Hutian 新输入框，未新增测试工程或公开发布。

## 11 月 16 日：空状态快照与频道读取

同日思考状态补充：可选 Dock bridge 不再把 reasoning 生命周期与正文一并丢弃，只放行 `codex_event` 的 `item` 开始／完成阶段及 `item.id/type`；剥离其余原生字段，thought/reasoning 文本增量继续过滤。Hutian 真实 Mac 运行收到成对事件并展示状态和时长，没有新建协议类型或读取原生私有思考。脚本语法与现有 TypeScript 检查通过，仍未提交。只支持实际收到的 Codex 元信息，不承诺其他 Provider 或历史回填。

设备离线时旧状态命令可能输出空文本，原读取逻辑解析该文件导致整个频道失败。可选观察快照为空 / JSON 不完整时保持 unknown，新的查询只发布同一 run 的有效状态；不改写原 job 或回执，不重复执行。已确认 replied / skipped 优先于陈旧观察，skipped 活动收敛终态。取消记录可根据同一 run 的原权限交互说明拒绝原因。

实际日报频道从 HTTP 500 恢复，后台沿原美股运行确认无需新报告并继续午报；午报随后因现有权限策略拒绝备用行情 shell 命令而取消，未冒称交付成功。真实 Chrome 频道点击、日历终态及 TypeScript 检查完成。保持第 20 段未提交，未扩大审批权限或发布。


## 11 月 16 日：定时协调的独立读取

增加只读取当前房间种类与成员的 `/api/room`，沿用原 Matrix 人类身份及明文房间检查，不读取历史执行文件。单条 `/api/agent/status` 补充宿主是否占用、原观察时间和错误；已经确认的回复、跳过和已保存结果优先于进程占用或陈旧观察。Hutian 定时派发与观察据此不再读取整个频道，恢复仍通过原消息及 Dock 回执，不重新执行。

类型检查通过；Hutian 14:38 的真实一次性安排完成并从日历打开原回复，编辑与删除后原运行保持。没有修改执行宿主身份、原生模型、权限、队列持久化格式或协议权威归属。保持本段未提交，未发布。

2026-11-16 思考摘要补充：可选 Dock 宿主在原生 reasoning 生命周期记录中，仅额外保留 Dock 明确投影的非空公开 `summary`（限制长度）；通用 thought/reasoning delta 与原始内容仍过滤。摘要随原活动持久保存，不回填旧记录。真实 Hutian Mac 私聊完成、展开与刷新读取通过；`pnpm check` 与运行桥语法检查通过。仍属第 20 段，保持未提交。


## 2026-11-16 原生权限模式透传

宿主执行配置允许透传原生 `mode` 字符串，与已有 `effort` / `serviceTier` 一同冻结在原工作记录和队列上下文；不在通信模块中定义权限模式，也不自动批准原生请求。既有 TypeScript 检查通过。Hutian 成员入口的真实 Mac 只读／工作区访问写文件结果分别被阻止／成功，工作快照保留对应 mode；本次未核对 Windows 或其他原生模式。继续保留第 20 段未提交。


2026-11-16 定时权限边界修正：新定时任务与普通聊天统一使用 dock-runtime，不再选择应用的工具白名单脚本；原生 Harness 负责权限判断。保持原生待授权请求和用户决定的透传，不扩大默认授权。宿主状态接口仅补充当前运行的待处理请求摘要，供应用显示等待并提醒；既有 job/receipt 不重建。旧 taskPolicyBridge 标识仅兼容历史核对。应用停止旧验证运行后，按新入口重新验证真实股票报告。

## 2026-11-16 普通聊天交付补充

宿主标准执行桥现在要求普通报告直接给出聊天正文与结论，只有实际文件任务才提供输出目录链接；不要求额外生成 ZIP。结束后只有正式回答引用本次输出目录时才进入自动文件收取，纯文字任务不触发整目录回传。原生执行、权限策略、既有回执与旧成果保留。Hutian 的真实时钟任务及同对话追问均完成，两个原生运行的 outputsState 为 none；未把历史大附件传输超时宣称修复。本项仍属第 20 段，保持未提交。
