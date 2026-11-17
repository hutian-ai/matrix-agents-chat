# Matrix Agents Chat

> **已开源，高频迭代中。** 接口、配置和交互仍会调整；使用前请查看本文与部署说明。仓库已迁入 `hutian-ai`，npm 包尚未发布。

面向人和 Agent 的独立通信工具：房间、成员、文本消息、引用回复、历史与断线补收。提供 TypeScript SDK、CLI 和本机网页入口。

人决定邀请谁、让谁回复，以及是否把一位助手的消息交给另一位。Matrix / Synapse 保存通信事实，外部宿主负责模型与真实执行；本项目不维护另一套消息数据库。

产品原名 Matrix Team Chat。现名为 Matrix Agents Chat，GitHub 仓库为 `hutian-ai/matrix-agents-chat`，SDK 名称为 `@hutian-ai/matrix-agents-chat`。已有本机工作目录与持久化服务标识继续兼容，身份、房间与执行回执不因更名重建。

## 现在能做什么

- 创建和切换邀请制明文房间，邀请多位独立身份的助手。
- 人与 Agent 使用相同的通信接口，发送、引用回复、分页读取历史。
- 网页手动选择回复对象；通过 Harness Dock 取得真实回复。
- 把 Agent 的回复连同人的要求转交给另一位，保留原生引用关系。
- 保存同步位置，断线后补收；宿主通过原回执核对运行并恢复回复。
- 可信后端通过 Matrix Application Service 创建无密码身份，再使用该身份自己的会话接入。

## 从干净目录启动

需要 Node.js 22.16+、pnpm 11 和正在运行的 Docker。首次准备会下载固定版本的 Synapse / PostgreSQL 镜像；数据库使用持久卷，应用使用独立的非管理员数据库账号。

```sh
pnpm install --frozen-lockfile
pnpm local:setup
pnpm web
```

打开 http://127.0.0.1:3310/。安装器会生成私有配置、三个聊天身份和一个房间。重复执行 `local:setup` 复用原数据与身份；检测到既有手工环境时会明确停止，不覆盖原配置。

初始助手通过外部应用接入，网页不会生成模拟 AI 回复。要调用真实模型，请按 [Dock 接入](docs/integration.md#在新环境配置-dock-宿主)配置你自己的执行宿主；已有本工作区配置可直接使用。SDK 接入不需要安装 Dock。

```sh
pnpm doctor          # 核对聊天身份、房间与宿主配置，不调用模型
pnpm local:status    # 独立安装的容器状态
pnpm local:stop      # 停止独立安装，保留数据
pnpm local:up        # 再次启动
```

端口、共享 PostgreSQL、已有环境、备份和恢复见 [部署说明](docs/deployment.md)。页面操作与更多助手配置见 [网页使用](docs/web-demo.md)。

## 网页使用

1. 新建房间，选择一起加入的助手；也可从“成员”入口继续邀请。
2. 发送消息，选中原文，在“由谁回复”选择助手，再手动触发。
3. 需要另一位接着处理时，点击回复下方的“转交给其他助手”，填写要求并发送。

发送和邀请本身不调用模型。状态、回复与原请求对应；断连或未知结果不自动生成替代运行。各助手可以有独立身份与执行配置，当前宿主示例串行使用 Dock 应用连接。

外部可信本机宿主可以通过 `POST /api/agents` 按稳定 ID 创建或更新受管助手；需要安装器生成的私有 Application Service 配置与已登记 namespace，旧部署应由运维增量登记。接口复用原用户会话与 device ID，不接受调用方提供凭据路径。创建后立即更新目录，无需重启网页。

`POST /api/agent` 的可选 context 接收调用方 instructions、定义版本、标签与来源，以及所选 Runtime 的描述；原 job 和提示保存当次快照。查询只返回来源元数据，不公开指令原文或凭据。角色和资源业务授权仍由外部产品负责。详见 [第 18 段](docs/stage-18.md)。

## SDK

核心仅依赖官方 `matrix-js-sdk`，构建结果不包含网页、CLI 或 Dock。

```sh
pnpm build
pnpm pack --pack-destination .local/packages
```

在另一个项目安装生成的 `.tgz`，或使用仓库源码。包当前保持 `private: true`，未发布到 npm。

```ts
import { createMatrixClient, sendMessage, readHistory } from '@hutian-ai/matrix-agents-chat';

const client = createMatrixClient({ baseUrl, userId, deviceId, accessToken });
// transactionId 由宿主在请求前持久保存；重试同一发送时沿用。
await sendMessage(client, { roomId, text: '你好', transactionId });
const page = await readHistory(client, { roomId, limit: 20 });
```

[SDK 接入说明](docs/sdk.md)包含无密码身份、房间、原生回复、分页与同步示例。应用服务总密钥只留在可信后端，不能交给网页或 Agent；普通身份使用各自的用户会话。

## CLI

```sh
pnpm chat send --text '请评审这个方案。'
pnpm chat history --limit 20
pnpm chat history --profile reviewer --json
pnpm chat sync --profile reviewer --once
pnpm agent --agent reviewer --room '!实际房间ID' --event '$人的消息ID'
pnpm agent --agent reviewer --room '!实际房间ID' --event '$同一消息ID' --status
```

未加入默认房间的身份需要显式指定 `--room`，不会为了让命令通过而自动加入房间。

`--peer` 沿用原协作助手会话；`--profile reviewer` 使用该名称的独立会话，二者分别使用。需要登录已有账号时运行 `pnpm matrix:login`、`pnpm matrix:login:peer` 或 `pnpm matrix:login --profile reviewer`，凭据模板见根目录的 `matrix*.env.example`。

## 范围

当前是本机使用的一位操作者、多位 Agent 通信入口，HTTP 服务只监听回环地址。其他产品通过 SDK 接入自己的认证与业务授权；本机网页不是对外多用户 API。

当前只处理明文房间，加密房间会拒绝操作。SDK 消息可附 Matrix 原生媒体元信息，可选宿主提供受限上传、读取和原成果回流接口；示例网页未增加完整文件管理或远程登录。可选宿主按当前身份权限读取有长度限制的近期历史及引用原文，不提供无限上下文或原生 session 迁移；记忆、知识库、项目管理、市场与自主调度由接入方承担。

不承诺跨设备业务去重或执行恰好一次。消息重复投递按 `event_id` 处理，未知执行沿原回执核对。模型与工具权限由实际 Harness 决定，提示词不构成隔离。

## 开发与许可

```sh
pnpm check
pnpm web:build
pnpm build
```

[架构与数据归属](docs/architecture.md) · [验证记录](docs/verification.md) · [开发记录](docs/development.md) · [更新记录](CHANGELOG.md)

项目源码采用 [MIT](LICENSE)，第三方组件保留各自许可，见 [依赖说明](THIRD_PARTY_NOTICES.md)。按用户要求，本次仅推送私有 GitHub 仓库，不代表公开开源、npm 发布或 X 发帖。

### Scheduled host work

The optional host accepts an explicit task execution mode, a bounded per-request wait and quiet completion when the caller's task requires no new result. Normal text chat keeps its previous behavior. Operators may configure `DOCK_TASK_CLIENT_ARGS_JSON` for an application-owned SDK client; callers cannot provide a command or path over HTTP. Native permissions remain native. Historical text deliveries can be fetched by exact event ID after current room access checks. See [stage 19](docs/stage-19.md); these source changes are not yet pushed or published.


### Interactive host integration

New applications can opt into real tool-backed chat with `context.interactive: true` on `/api/agent`. The optional host returns public activity, native requests, confirmed controls, a persistent admission queue and collected outputs. It uses the public Dock SDK; the core Matrix SDK remains independent. The existing example UI retains its manual message/reply flow. See [stage 20](docs/stage-20.md) for interfaces, independent use and actual verification boundaries.

### 可选执行宿主入口

执行宿主实现位于 `host/`；`pnpm host` 启动正式 HTTP 入口，`pnpm web` 先构建独立网页再启动宿主。旧 `examples` 路径仅作兼容转发，原 `.local` 身份、队列与回执位置不变。`@hutian-ai/matrix-agents-chat/host-client` 提供本机客户端，检查响应的 host protocol 1；它与 Matrix 通信 SDK 分开导出，不改变 Matrix 协议。当前宿主按源码部署，尚未发布独立宿主制品。
