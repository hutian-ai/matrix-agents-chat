# SDK 接入

构建与打包：`pnpm build`、`pnpm pack --pack-destination .local/packages`。在另一个 Node 项目安装生成的 `.tgz`，从 `@hutian-ai/matrix-agents-chat` 导入。包内只包含通信核心、类型、说明和许可，运行依赖为官方 `matrix-js-sdk`。

## 身份

已有 Matrix 用户会话可直接使用 `createMatrixClient({ baseUrl, userId, deviceId, accessToken })`。账号、设备和令牌由接入方管理；同一身份可用于房间、消息和同步。

应用自己的用户 / Agent 无需再手动注册一套密码。服务器管理员先注册窄范围 Application Service，可信宿主再调用：

```ts
import { createMatrixClient, provisionIdentity } from '@hutian-ai/matrix-agents-chat';

const service = createMatrixClient({ baseUrl, accessToken: applicationServiceToken });
const session = await provisionIdentity(service, {
  localpart: '_mtc_agent_42',
  deviceId: 'MY_HOST_AGENT_42',
});
// 在后端私有持久存储保存会话，后续复用它，不要每条消息重新登录。
const agent = createMatrixClient(session);
```

默认独立安装已注册 `_mtc_` 命名空间，AS 配置位于 `.local/application-service.json`。接入方负责将自己的稳定内部 ID 映射到命名空间内的 localpart，并核对谁有权操作该身份。返回的是该用户自己的普通会话，AS 总密钥不交给客户端或 Agent。

`provisionIdentity` 使用 `m.login.application_service` 无密码注册 / 登录；已有用户不会重复注册，但调用会取得一份会话。要求 homeserver 支持此登录方式，本项目固定版本的 Synapse 已实测；不支持的服务器会明确报错，不退回共享管理员身份。

## 房间与成员

```ts
import { ensureRoom, inviteMember, joinRoom } from '@hutian-ai/matrix-agents-chat';

const { roomId } = await ensureRoom(human, { aliasLocalpart: 'design', name: '方案讨论' });
await inviteMember(human, roomId, agent.getSafeUserId());
await joinRoom(agent, roomId);
```

房间按别名查找或创建，邀请制、私有目录、关闭该房间联邦。已有房间不覆盖名称和权限。邀请不代表已加入，也不会授予工具权限；被邀请者使用自己的客户端接受。

## 消息、引用与历史

```ts
import { sendMessage, readHistory } from '@hutian-ai/matrix-agents-chat';

const original = await sendMessage(human, { roomId, text: '请评审方案', transactionId: savedRequestId });
await sendMessage(agent, {
  roomId, text: '建议补充验收条件。', replyTo: original.event_id,
  transactionId: savedReplyRequestId,
});
const page = await readHistory(human, { roomId, limit: 20 });
if (page.nextCursor) await readHistory(human, { roomId, from: page.nextCursor, limit: 20 });
```

返回原始 Matrix 事件，历史按从新到旧分页，每页最多 100。引用使用原生 `m.in_reply_to`，目标必须是同一房间内可读取的文本。加密房间拒绝操作。

发送前保存 `transactionId`，重试沿用；新消息用新 ID。事务去重范围遵循 Matrix 的同一账号 / 设备会话，不提供跨设备业务去重。消息权限和历史可见性以 homeserver 为准。

## 同步与断线补收

```ts
import { syncRoom } from '@hutian-ai/matrix-agents-chat';

const batch = await syncRoom(agent, { roomId, since: savedCursor, limit: 100, timeoutMs: 25_000 });
for (const event of batch.events) await yourHostProcess(event); // 按 event_id 处理重投
await saveCursor(batch.nextCursor); // 仅在处理成功后推进
```

首次省略 `since`，返回最近快照，`initial` 为 true；它不是所有历史。后续截断区间用原生消息分页补齐，`backfilled` 表示本批补收。处理失败保留旧游标。处理后、保存游标前崩溃仍可能重投；SDK 不把消息接收自动转成模型执行。

## 接入执行

你自己的宿主决定授权、预算、工具和任务生命周期。可以只使用通信 SDK，也可按 `examples/dock-host.ts` 接入 Harness Dock。人工转交记录为一条人类引用消息，宿主接受人的指令，再读取目标 Agent 有权查看的引用原文，不开放 Agent 消息递归触发。

本仓库通过 pnpm 为固定版本 SDK 应用 Node 超时计时器补丁，见 `patches/`；SDK tarball 不会自动替接入方修改依赖。仓库外单次 Node 脚本仍可能沿用上游计时器退出行为，通信返回值和权限仍由原 SDK 决定。

八个运行时导出：`createMatrixClient`、`provisionIdentity`、`ensureRoom`、`inviteMember`、`joinRoom`、`sendMessage`、`readHistory`、`syncRoom`。

官方依据：[应用服务身份](https://spec.matrix.org/latest/application-service-api/#server-admin-style-permissions)、[回复关系](https://spec.matrix.org/latest/client-server-api/#rich-replies)、[同步](https://spec.matrix.org/latest/client-server-api/#get_matrixclientv3sync)、[事务 ID](https://spec.matrix.org/latest/client-server-api/#transaction-identifiers)。
