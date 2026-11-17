import { watch } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { loadDotenv } from "c12";
import { cleanEnv, port } from "envalid";
import { H3, HTTPError, readBody, serve } from "h3";
import { EventType, MatrixError, MsgType } from "matrix-js-sdk";
import { staticMiddleware } from "srvx/static";
import { loadLocalClient, loadLocalRoom } from "../../src/local.js";
import { readHistory, sendMessage } from "../../src/message.js";
import {
  assertPlaintextRoom,
  ensureRoom,
  inviteMember,
  joinRoom,
  isRoomArchived,
  setRoomArchived,
} from "../../src/room.js";
import {
  HostRequestError,
  inspectHostRequest,
  jobLocation,
  type HostContext,
} from "../dock-host.js";
import {
  activeHostRequest,
  hostOutcome,
  launchHostRequest,
  queuedHostRequests,
  pumpHostQueue,
  changeQueuedRequest,
  hostQueueState,
} from "../host-worker.js";
import { retrieveHostOutputs } from "../host-outputs.js";
import { readHostRuntime } from "../host-runtime.js";
import { readHostActivity, sendHostControl } from "../host-activity.js";
import {
  ensureManagedAgent,
  loadAgentProfiles,
  publicAgent,
  type AgentProfile,
} from "../agents.js";
import {
  uploadChatFile,
  uploadedChatFile,
  downloadChatFile,
  type ChatFile,
} from "../chat-files.js";

async function main() {
  const root = resolve(import.meta.dirname, "../..");
  const environment = await loadDotenv({
    cwd: root,
    fileName: ".local/web.env",
    env: process.env,
    interpolate: false,
  });
  const configuration = cleanEnv(environment, {
    WEB_PORT: port({ default: 3310 }),
  });
  const origin = `http://127.0.0.1:${configuration.WEB_PORT}`;
  const host = new URL(origin).host;
  const directory = resolve(root, ".local/web-dist");
  await access(resolve(directory, "index.html"));
  const human = await loadLocalClient();
  let agents = await loadAgentProfiles();
  const defaultRoomId = await loadLocalRoom(human);
  for (const agent of agents) {
    if (
      human.getSafeUserId() === agent.client.getSafeUserId() ||
      human.getHomeserverUrl() !== agent.client.getHomeserverUrl()
    ) {
      throw new Error("助手需要同一服务上的独立聊天身份。");
    }
    if (agent.hostConfigFile) {
      const settings = await loadDotenv({
        cwd: root,
        fileName: agent.hostConfigFile,
        env: {},
        interpolate: false,
      });
      if (settings.HOST_ALLOWED_SENDER !== human.getSafeUserId())
        throw new Error("宿主允许的发送者与网页使用的账号不一致。");
    }
  }
  let byUserId = new Map(
    agents.map((agent) => [agent.client.getSafeUserId(), agent]),
  );

  function reject(status: number, message: string): never {
    throw new HTTPError({ status, message });
  }

  async function roomName(roomId: string) {
    try {
      const value = await human.getStateEvent(roomId, EventType.RoomName, "");
      return typeof value.name === "string" && value.name.trim()
        ? value.name
        : roomId;
    } catch (error) {
      if (error instanceof MatrixError && error.errcode === "M_NOT_FOUND")
        return roomId;
      throw error;
    }
  }

  // 阅读和发送由人的原生成员身份授权；执行另行核对所选 Agent 的成员身份。
  async function requireRoom(value: unknown) {
    if (
      typeof value !== "string" ||
      !value.startsWith("!") ||
      value.length > 500
    )
      reject(400, "请选择有效的房间。");
    try {
      const membership = await human.getStateEvent(
        value,
        EventType.RoomMember,
        human.getSafeUserId(),
      );
      if (membership.membership !== "join")
        reject(404, "房间不存在，或你尚未加入。");
      await assertPlaintextRoom(human, value);
    } catch (error) {
      if (
        error instanceof MatrixError &&
        ["M_FORBIDDEN", "M_NOT_FOUND"].includes(error.errcode ?? "")
      ) {
        reject(404, "房间不存在，或你尚未加入。");
      }
      if (error instanceof Error && error.message === "CHAT_ENCRYPTED_ROOM")
        reject(409, "当前网页仅支持明文房间。");
      throw error;
    }
    return value;
  }

  function configuredAgent(value: unknown) {
    const agent = agents.find((profile) => profile.id === value);
    if (!agent) reject(400, "请选择已接入的助手。");
    return agent;
  }

  async function requireAgent(roomId: string, value: unknown) {
    const agent = configuredAgent(value);
    if (!agent.hostConfigFile)
      reject(409, "这位助手通过外部 SDK 接入，尚未配置网页执行宿主。");
    try {
      const member = await agent.client.getStateEvent(
        roomId,
        EventType.RoomMember,
        agent.client.getSafeUserId(),
      );
      if (member.membership !== "join")
        reject(409, "所选助手尚未加入当前房间，请先邀请。");
    } catch (error) {
      if (
        error instanceof MatrixError &&
        ["M_FORBIDDEN", "M_NOT_FOUND"].includes(error.errcode ?? "")
      ) {
        reject(409, "所选助手尚未加入当前房间，请先邀请。");
      }
      throw error;
    }
    return agent;
  }

  async function messageId(body: unknown) {
    if (
      !body ||
      typeof body !== "object" ||
      !("eventId" in body) ||
      typeof body.eventId !== "string" ||
      body.eventId.length > 500 ||
      !body.eventId.startsWith("$")
    ) {
      reject(400, "请选择一条有效消息。");
    }
    const roomId = await requireRoom(
      "roomId" in body ? body.roomId : undefined,
    );
    const event = await human
      .fetchRoomEvent(roomId, body.eventId)
      .catch((error) => {
        if (
          error instanceof MatrixError &&
          ["M_FORBIDDEN", "M_NOT_FOUND"].includes(error.errcode ?? "")
        )
          reject(404, "当前房间没有这条消息。");
        throw error;
      });
    if (
      event.sender !== human.getSafeUserId() ||
      event.type !== EventType.RoomMessage ||
      event.content?.msgtype !== MsgType.Text ||
      !event.content.body?.trim()
    ) {
      reject(403, "只能把自己在当前房间发送的文本交给助手。");
    }
    const agent = await requireAgent(
      roomId,
      "agentId" in body ? body.agentId : undefined,
    );
    return { roomId, eventId: body.eventId, agent };
  }

  async function launch(
    agent: AgentProfile,
    roomId: string,
    eventId: string,
    resumeOnly: boolean,
    context?: HostContext,
  ) {
    try {
      await launchHostRequest(agent, roomId, eventId, resumeOnly, context);
    } catch (error) {
      reject(
        409,
        error instanceof HostRequestError
          ? error.message
          : "宿主正在接收另一个请求，请稍后核对原消息。",
      );
    }
    return { accepted: true };
  }

  const app = new H3({
    debug: false,
    silent: true,
    onError: (error) =>
      Response.json(
        {
          error:
            error.status < 500
              ? error.message
              : "服务暂时不可用，请检查本机服务后重试。",
        },
        { status: error.status },
      ),
  }).use((event) => {
    if (event.req.headers.get("host") !== host)
      reject(403, "请从本机页面访问。");
    if (
      !["GET", "HEAD"].includes(event.req.method) &&
      (event.req.headers.get("origin") !== origin ||
        event.req.headers.get("content-type")?.split(";")[0] !==
          "application/json")
    ) {
      reject(403, "请从当前聊天室页面提交操作。");
    }
    event.res.headers.set("X-Matrix-Agents-Host-Protocol", "1");
    event.res.headers.set("Cache-Control", "no-store");
    event.res.headers.set("X-Content-Type-Options", "nosniff");
    event.res.headers.set("Referrer-Policy", "no-referrer");
    event.res.headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
    );
  });

  app.get("/api/health", () => ({ status: "ok", protocolVersion: 1 }));
  app.get("/api/runtime", async (event) => {
    const query = new URL(event.req.url).searchParams;
    const clientId = query.get("clientId");
    const nodeId = query.get("nodeId") ?? undefined;
    if (
      !clientId?.match(/^[\da-f-]{36}$/i) ||
      (nodeId && !/^[\da-f-]{36}$/i.test(nodeId))
    )
      reject(400, "请选择有效执行连接。");
    try {
      return await readHostRuntime(clientId, nodeId, agents);
    } catch (error) {
      reject(
        409,
        error instanceof HostRequestError
          ? error.message
          : "执行连接暂不可读取，请核对原运行；不需要重新导入凭据。",
      );
    }
  });

  app.post("/api/agents", async (event) => {
    const body = await readBody<{
      id?: unknown;
      name?: unknown;
      description?: unknown;
    }>(event);
    if (
      !body ||
      typeof body.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,49}$/u.test(body.id) ||
      typeof body.name !== "string" ||
      !body.name.trim() ||
      body.name.length > 80 ||
      typeof body.description !== "string" ||
      body.description.length > 240
    )
      reject(400, "请输入有效的助手标识、名称与职责。");
    try {
      const agent = await ensureManagedAgent({
        id: body.id,
        name: body.name.trim(),
        description: body.description,
      });
      agents = await loadAgentProfiles();
      byUserId = new Map(
        agents.map((profile) => [profile.client.getSafeUserId(), profile]),
      );
      return { agent: publicAgent(agent) };
    } catch {
      reject(
        409,
        "助手身份尚未确认，请检查受管身份与宿主配置；再次操作会核对原身份。",
      );
    }
  });

  app.get("/api/rooms", async (event) => {
    const includeArchived =
      new URL(event.req.url).searchParams.get("includeArchived") === "true";
    const own = await human.getJoinedRooms();
    const rooms = await Promise.all(
      own.joined_rooms.map(async (id) => {
        try {
          await assertPlaintextRoom(human, id);
        } catch (error) {
          if (error instanceof Error && error.message === "CHAT_ENCRYPTED_ROOM")
            return null;
          if (
            error instanceof MatrixError &&
            ["M_FORBIDDEN", "M_NOT_FOUND"].includes(error.errcode ?? "")
          )
            return null;
          throw error;
        }
        const archived = await isRoomArchived(human, id);
        if (archived && !includeArchived) return null;
        const creation = await human.getStateEvent(
          id,
          EventType.RoomCreate,
          "",
        );
        const kind = creation["org.hutian.agents-chat.kind"];
        return {
          id,
          name: await roomName(id),
          kind: kind === "direct" || kind === "channel" ? kind : "group",
          archived,
        };
      }),
    );
    return {
      rooms: rooms
        .filter((room) => room !== null)
        .sort(
          (a, b) =>
            a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id),
        ),
      agents: agents.map(publicAgent),
      defaultRoomId,
    };
  });

  app.post("/api/rooms/archive", async (event) => {
    const body = await readBody<{ roomId?: unknown; archived?: unknown }>(
      event,
    );
    const roomId = await requireRoom(body?.roomId);
    if (typeof body?.archived !== "boolean")
      reject(400, "请选择归档或恢复房间。");
    return setRoomArchived(human, roomId, body.archived);
  });

  app.post("/api/rooms", async (event) => {
    const body = await readBody<{
      name?: unknown;
      transactionId?: unknown;
      agentIds?: unknown;
      kind?: unknown;
    }>(event);
    if (
      !body ||
      typeof body.name !== "string" ||
      !body.name.trim() ||
      body.name.length > 80 ||
      typeof body.transactionId !== "string" ||
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u.test(body.transactionId)
    ) {
      reject(400, "请输入 1 到 80 个字符的房间名称，并沿用创建请求。");
    }
    if (
      !Array.isArray(body.agentIds) ||
      body.agentIds.length > agents.length ||
      new Set(body.agentIds).size !== body.agentIds.length
    ) {
      reject(400, "请选择要加入房间的助手。");
    }
    const invited = body.agentIds.map(configuredAgent);
    if (
      body.kind !== undefined &&
      !["direct", "group", "channel"].includes(String(body.kind))
    )
      reject(400, "请选择私聊、群聊或频道。");
    if (body.kind === "direct" && invited.length !== 1)
      reject(400, "私聊只能选择一位助手。");
    // 固定别名使创建超时后的重试回到原房间；邀请、接受邀请也可继续完成。
    const result = await ensureRoom(human, {
      aliasLocalpart: `web-${body.transactionId}`,
      name: body.name.trim(),
      ...(body.kind === undefined
        ? {}
        : { kind: body.kind as "direct" | "group" | "channel" }),
    });
    await assertPlaintextRoom(human, result.roomId);
    for (const agent of invited) {
      await inviteMember(human, result.roomId, agent.client.getSafeUserId());
      await joinRoom(agent.client, result.roomId);
    }
    return { room: { id: result.roomId, name: await roomName(result.roomId) } };
  });

  app.post("/api/members", async (event) => {
    const body = await readBody<{ roomId?: unknown; agentId?: unknown }>(event);
    const roomId = await requireRoom(body?.roomId);
    const agent = configuredAgent(body?.agentId);
    await inviteMember(human, roomId, agent.client.getSafeUserId());
    await joinRoom(agent.client, roomId);
    return { joined: true, agentId: agent.id };
  });

  // Membership and room metadata must not depend on any historical execution.
  app.get("/api/room", async (event) => {
    const roomId = await requireRoom(
      new URL(event.req.url).searchParams.get("roomId"),
    );
    const [name, membership, creation] = await Promise.all([
      roomName(roomId),
      human.getJoinedRoomMembers(roomId),
      human.getStateEvent(roomId, EventType.RoomCreate, ""),
    ]);
    const kind = creation["org.hutian.agents-chat.kind"];
    return {
      room: {
        id: roomId,
        name,
        kind: kind === "direct" || kind === "channel" ? kind : "group",
      },
      members: Object.entries(membership.joined).map(([id, member]) => ({
        id,
        name:
          id === human.getSafeUserId()
            ? "你"
            : (byUserId.get(id)?.name ?? member.display_name ?? id),
        kind:
          id === human.getSafeUserId()
            ? "human"
            : byUserId.has(id)
              ? "agent"
              : "other",
      })),
      agents: agents.map((agent) => ({
        ...publicAgent(agent),
        joined: agent.client.getSafeUserId() in membership.joined,
      })),
    };
  });

  app.get("/api/state", async (event) => {
    const query = new URL(event.req.url).searchParams;
    const roomId = await requireRoom(query.get("roomId"));
    const cursor = query.get("cursor");
    if (cursor && cursor.length > 4000) reject(400, "历史位置无效。");
    const [page, name, membership] = await Promise.all([
      readHistory(human, {
        roomId,
        limit: 100,
        ...(cursor ? { from: cursor } : {}),
      }),
      roomName(roomId),
      human.getJoinedRoomMembers(roomId),
    ]);
    const active = await activeHostRequest();
    const members = Object.entries(membership.joined).map(([id, member]) => ({
      id,
      name:
        id === human.getSafeUserId()
          ? "你"
          : (byUserId.get(id)?.name ?? member.display_name ?? id),
      kind:
        id === human.getSafeUserId()
          ? "human"
          : byUserId.has(id)
            ? "agent"
            : "other",
    }));
    const roomAgents = agents.map((agent) => ({
      ...publicAgent(agent),
      joined: agent.client.getSafeUserId() in membership.joined,
    }));
    const messages = page.events
      .filter(
        (event) =>
          event.content?.msgtype === MsgType.Text &&
          typeof event.content.body === "string",
      )
      .reverse()
      .map((event) => ({
        id: event.event_id,
        text: event.content.body,
        timestamp: event.origin_server_ts,
        sender:
          event.sender === human.getSafeUserId()
            ? "human"
            : byUserId.has(event.sender)
              ? "agent"
              : "other",
        name:
          event.sender === human.getSafeUserId()
            ? "你"
            : (byUserId.get(event.sender)?.name ?? event.sender),
        agentId: byUserId.get(event.sender)?.id ?? null,
        replyTo:
          event.content["m.relates_to"]?.["m.in_reply_to"]?.event_id ?? null,
        attachments: Array.isArray(
          event.content["org.hutian.agents-chat.attachments"],
        )
          ? event.content["org.hutian.agents-chat.attachments"]
          : [],
        mentionedUserIds: Array.isArray(event.content["m.mentions"]?.user_ids)
          ? event.content["m.mentions"].user_ids
          : [],
      }));
    const sources = [
      ...new Set(
        messages.flatMap((message) =>
          message.sender === "human"
            ? [message.id]
            : message.agentId && message.replyTo
              ? [message.replyTo]
              : [],
        ),
      ),
    ];
    const jobs = await Promise.all(
      sources.flatMap((eventId) =>
        agents.map(async (agent) => {
          const job = await inspectHostRequest(agent.client, roomId, eventId);
          const outcome = await hostOutcome(agent.client, roomId, eventId);
          const running =
            active?.agentId === agent.id &&
            active.roomId === roomId &&
            active.eventId === eventId;
          if (!job && !running && !outcome) return null;
          return {
            agentId: agent.id,
            eventId,
            runId: job?.runId ?? null,
            instructionsVersion: job?.instructionsVersion ?? null,
            instructionsLabel: job?.instructionsLabel ?? null,
            instructionsSource: job?.instructionsSource ?? null,
            runtimeLabel: job?.runtimeLabel ?? null,
            nodeId: job?.nodeId ?? null,
            provider: job?.provider ?? null,
            model: job?.model ?? null,
            config: job?.config ?? null,
            state: running
              ? "running"
              : job &&
                  [
                    "replied",
                    "skipped",
                    "completed",
                    "failed",
                    "cancelled",
                  ].includes(job.state)
                ? job.state
                : (outcome?.result?.state ?? job?.state ?? "idle"),
            replyEventId: job?.replyEventId ?? null,
            hasReceipt: job?.hasReceipt ?? false,
            error:
              job && ["replied", "skipped", "completed"].includes(job.state)
                ? null
                : (job?.error ??
                  outcome?.error ??
                  outcome?.result?.reason ??
                  null),
            checkedAt: outcome?.checkedAt ?? 0,
            activity: await readHostActivity(agent.client, roomId, eventId),
          };
        }),
      ),
    );
    return {
      room: { id: roomId, name },
      members,
      agents: roomAgents,
      messages,
      jobs: jobs.filter((job) => job !== null),
      nextCursor: page.events.length ? page.nextCursor : null,
      queue: (await queuedHostRequests())
        .filter((q) => q.roomId === roomId)
        .map((q) => ({
          id: q.id,
          eventId: q.eventId,
          agentId: q.agentId,
          state: q.state,
          createdAt: q.createdAt,
        })),
      active: active
        ? {
            agentId: active.agentId,
            roomId: active.roomId,
            eventId: active.eventId,
          }
        : null,
    };
  });

  app.get("/api/message", async (event) => {
    const query = new URL(event.req.url).searchParams;
    const roomId = await requireRoom(query.get("roomId"));
    const eventId = query.get("eventId");
    if (!eventId || !eventId.startsWith("$") || eventId.length > 500)
      reject(400, "请选择原消息。");
    const message = await human.fetchRoomEvent(roomId, eventId);
    if (
      message.type !== EventType.RoomMessage ||
      message.content?.msgtype !== MsgType.Text ||
      typeof message.content.body !== "string"
    )
      reject(404, "原消息不可读取。");
    return {
      id: message.event_id,
      text: message.content.body,
      sender: message.sender,
      isOwn: message.sender === human.getSafeUserId(),
      agentId: byUserId.get(message.sender ?? "")?.id ?? null,
      timestamp: message.origin_server_ts,
      replyTo:
        message.content["m.relates_to"]?.["m.in_reply_to"]?.event_id ?? null,
    };
  });

  app.post("/api/messages", async (event) => {
    const body = await readBody<{
      roomId?: unknown;
      text?: unknown;
      transactionId?: unknown;
      replyTo?: unknown;
      uploadIds?: unknown;
      mentionedAgentIds?: unknown;
    }>(event);
    if (
      !body ||
      typeof body.text !== "string" ||
      !body.text.trim() ||
      body.text.length > 16_000 ||
      typeof body.transactionId !== "string" ||
      !/^[\w-]{1,100}$/u.test(body.transactionId)
    ) {
      reject(400, "请输入 1 到 16000 个字符的消息。");
    }
    const roomId = await requireRoom(body.roomId);
    if (
      body.mentionedAgentIds !== undefined &&
      (!Array.isArray(body.mentionedAgentIds) ||
        body.mentionedAgentIds.length > 20 ||
        body.mentionedAgentIds.some((id) => typeof id !== "string"))
    )
      reject(400, "点名成员无效。");
    const mentioned = ((body.mentionedAgentIds ?? []) as string[]).map(
      configuredAgent,
    );
    if (mentioned.length) {
      const membership = await human.getJoinedRoomMembers(roomId);
      if (
        mentioned.some((a) => !(a.client.getSafeUserId() in membership.joined))
      )
        reject(400, "点名成员已不在当前会话中。");
    }
    if (
      body.replyTo !== undefined &&
      (typeof body.replyTo !== "string" ||
        !body.replyTo.startsWith("$") ||
        body.replyTo.length > 500)
    ) {
      reject(400, "请选择有效的引用消息。");
    }
    if (typeof body.replyTo === "string") {
      const target = await human
        .fetchRoomEvent(roomId, body.replyTo)
        .catch((error) => {
          if (
            error instanceof MatrixError &&
            ["M_FORBIDDEN", "M_NOT_FOUND"].includes(error.errcode ?? "")
          )
            reject(404, "当前房间没有这条引用消息。");
          throw error;
        });
      if (
        target.type !== EventType.RoomMessage ||
        target.content?.msgtype !== MsgType.Text ||
        typeof target.content.body !== "string" ||
        !target.content.body.trim() ||
        target.content.body.length > 16_000
      ) {
        reject(400, "只能引用可读取的文本消息。");
      }
    }
    if (
      body.uploadIds !== undefined &&
      (!Array.isArray(body.uploadIds) ||
        body.uploadIds.length > 5 ||
        body.uploadIds.some((id) => typeof id !== "string"))
    )
      reject(400, "每条消息最多附加五份文件。");
    const attachments = await Promise.all(
      ((body.uploadIds ?? []) as string[]).map((id) =>
        uploadedChatFile(human, id),
      ),
    );
    const sent = await sendMessage(human, {
      roomId,
      text: body.text,
      transactionId: body.transactionId,
      attachments,
      mentionedUserIds: mentioned.map((a) => a.client.getSafeUserId()),
      ...(body.replyTo === undefined ? {} : { replyTo: body.replyTo }),
    });
    return { eventId: sent.event_id };
  });

  app.post("/api/agent", async (event) => {
    const body = await readBody<{ context?: unknown }>(event);
    const { roomId, eventId, agent } = await messageId(body);
    let context: HostContext | undefined;
    if (body && body.context !== undefined) {
      if (
        !body.context ||
        typeof body.context !== "object" ||
        Array.isArray(body.context) ||
        Object.keys(body.context).some(
          (key) =>
            ![
              "toolBridgeUrl",
              "toolBridgeToken",
              "material",
              "nodeId",
              "provider",
              "model",
              "config",
              "connectionId",
              "instructions",
              "instructionsVersion",
              "instructionsLabel",
              "instructionsSource",
              "runtimeLabel",
              "timeoutMs",
              "executionMode",
              "silentNoUpdate",
              "interactive",
            ].includes(key),
        )
      )
        reject(400, "执行上下文格式有误。");
      context = body.context as HostContext;
      if (
        context.config !== undefined &&
        (!context.config ||
          typeof context.config !== "object" ||
          Array.isArray(context.config) ||
          Object.entries(context.config).some(
            ([key, value]) =>
              !["effort", "serviceTier", "mode", "nativeMemory"].includes(
                key,
              ) ||
              (key === "nativeMemory" && value !== "disabled") ||
              typeof value !== "string" ||
              !value.trim() ||
              value.length > 80,
          ))
      )
        reject(400, "执行配置无效。");
      if (
        context.silentNoUpdate !== undefined &&
        typeof context.silentNoUpdate !== "boolean"
      )
        reject(400, "静默交付设置无效。");
      if (
        context.interactive !== undefined &&
        typeof context.interactive !== "boolean"
      )
        reject(400, "交互设置无效。");
      if (
        context.executionMode !== undefined &&
        !["text", "task"].includes(context.executionMode)
      )
        reject(400, "请选择有效执行方式。");
      if (
        context.timeoutMs !== undefined &&
        (!Number.isSafeInteger(context.timeoutMs) ||
          context.timeoutMs < 180000 ||
          context.timeoutMs > 3600000)
      )
        reject(400, "执行等待时间超出允许范围。");
      for (const [key, value] of Object.entries(context).filter(
        ([key]) =>
          !["timeoutMs", "silentNoUpdate", "interactive", "config"].includes(
            key,
          ),
      ))
        if (
          typeof value !== "string" ||
          !value.trim() ||
          value.length >
            (key === "material" ? 48000 : key === "instructions" ? 22000 : 200)
        )
          reject(400, "执行上下文超出允许范围。");
      if (
        context.toolBridgeUrl &&
        !/^http:\/\/127\.0\.0\.1:\d{2,5}\/api\/[a-z-]+$/.test(
          context.toolBridgeUrl,
        )
      )
        reject(400, "工具回调必须使用本机应用入口。");
      if (
        context.toolBridgeToken &&
        !/^[a-f0-9]{64}$/.test(context.toolBridgeToken)
      )
        reject(400, "工具授权无效。");
      if (context.nodeId && !/^[\da-f-]{36}$/u.test(context.nodeId))
        reject(400, "请选择有效设备。");
      if (
        context.connectionId &&
        !/^[a-z][a-z0-9-]{0,49}$/u.test(context.connectionId)
      )
        reject(400, "请选择有效执行连接。");
    }
    return launch(agent, roomId, eventId, false, context);
  });
  app.post("/api/agent/resume", async (event) => {
    const { roomId, eventId, agent } = await messageId(await readBody(event));
    const job = await inspectHostRequest(agent.client, roomId, eventId);
    if (!job) reject(409, "没有原任务记录，未发起新运行。");
    if (!job.hasReceipt)
      reject(409, "原请求尚无 Dock 回执，无法确认执行状态；未重新派发。");
    return launch(agent, roomId, eventId, true);
  });
  // Observe only the original run's activity; no Matrix history polling per delta.
  app.get("/api/agent/activity-changes", async (event) => {
    const query = Object.fromEntries(new URL(event.req.url).searchParams);
    const { roomId, eventId, agent } = await messageId(query);
    const job = await inspectHostRequest(agent.client, roomId, eventId);
    if (!job || job.runId !== query.runId) reject(404, "原运行不可读取。");
    const { directory } = jobLocation(agent.client, roomId, eventId);
    const revision = async () => {
      try {
        const file = await stat(resolve(directory, "activity.json"));
        return `${file.mtimeMs}:${file.size}`;
      } catch {
        return "";
      }
    };
    let cursor = await revision();
    if (cursor === query.cursor)
      await new Promise<void>((done) => {
        let watcher: ReturnType<typeof watch> | undefined;
        const finish = () => {
          clearTimeout(timer);
          watcher?.close();
          event.req.signal.removeEventListener("abort", finish);
          done();
        };
        const timer = setTimeout(finish, 15000);
        event.req.signal.addEventListener("abort", finish, { once: true });
        try {
          watcher = watch(directory, (_kind, filename) => {
            if (filename === "activity.json") finish();
          });
          watcher.on("error", finish);
        } catch {
          finish();
        }
        void revision().then((value) => {
          if (value !== cursor) finish();
        });
        if (event.req.signal.aborted) finish();
      });
    cursor = await revision();
    return {
      cursor,
      agentId: agent.id,
      eventId,
      runId: job.runId,
      activity: await readHostActivity(agent.client, roomId, eventId),
    };
  });

  app.post("/api/agent/control", async (event) => {
    const body = await readBody<Record<string, unknown>>(event);
    if (!body) reject(400, "缺少执行操作。");
    const { roomId, eventId, agent } = await messageId(body);
    if (
      typeof body.operationId !== "string" ||
      !/^[\da-f-]{36}$/i.test(body.operationId) ||
      typeof body.runId !== "string" ||
      !/^[\da-f-]{36}$/i.test(body.runId) ||
      !["steer", "stop", "respond"].includes(String(body.kind))
    )
      reject(400, "执行操作格式无效。");
    if (
      body.kind === "steer" &&
      (typeof body.text !== "string" ||
        !body.text.trim() ||
        body.text.length > 16000)
    )
      reject(400, "请输入补充要求。");
    if (
      body.kind === "respond" &&
      (typeof body.requestId !== "string" || body.requestId.length > 500)
    )
      reject(400, "请选择当前请求。");
    try {
      return await sendHostControl(
        agent.client,
        roomId,
        eventId,
        {
          id: body.operationId,
          runId: body.runId,
          kind: body.kind as "steer" | "stop" | "respond",
          ...(typeof body.text === "string" ? { text: body.text } : {}),
          ...(typeof body.requestId === "string"
            ? { requestId: body.requestId }
            : {}),
          ...(body.response === undefined ? {} : { response: body.response }),
        },
        body.kind === "steer"
          ? async () => {
              await sendMessage(human, {
                roomId,
                text: body.text as string,
                transactionId: `steer-${body.operationId}`,
                replyTo: eventId,
              });
            }
          : undefined,
      );
    } catch (error) {
      reject(
        409,
        error instanceof HostRequestError
          ? error.message
          : "操作尚未确认，请核对原运行。",
      );
    }
  });
  app.post("/api/agent/queue", async (event) => {
    const body = await readBody<Record<string, unknown>>(event);
    const roomId = await requireRoom(body?.roomId);
    if (
      !body ||
      typeof body.id !== "string" ||
      !/^[\da-f-]{36}$/i.test(body.id) ||
      !["cancel", "start"].includes(String(body.action))
    )
      reject(400, "排队操作无效。");
    await changeQueuedRequest(
      body.id,
      roomId,
      body.action as "cancel" | "start",
    );
    return { accepted: true };
  });
  app.post("/api/uploads", async (event) => {
    const body = await readBody<Record<string, unknown>>(event);
    await requireRoom(body?.roomId);
    if (
      !body ||
      typeof body.name !== "string" ||
      typeof body.mime !== "string" ||
      typeof body.contentBase64 !== "string"
    )
      reject(400, "文件格式有误。");
    try {
      return await uploadChatFile(human, {
        name: body.name,
        mime: body.mime,
        contentBase64: body.contentBase64,
      });
    } catch {
      reject(400, "上传未完成，请检查文件名称和大小。");
    }
  });
  app.get("/api/input", async (event) => {
    const q = new URL(event.req.url).searchParams;
    const roomId = await requireRoom(q.get("roomId"));
    const source = await human.fetchRoomEvent(roomId, q.get("eventId") ?? "");
    const files = source.content?.["org.hutian.agents-chat.attachments"];
    const file = Array.isArray(files)
      ? files.find((f: ChatFile) => f.id === q.get("id"))
      : null;
    if (!file) reject(404, "当前消息没有这份附件。");
    try {
      return {
        ...file,
        contentBase64: (await downloadChatFile(human, file)).toString("base64"),
      };
    } catch {
      reject(404, "原附件当前不可读取。");
    }
  });
  app.get("/api/agent/outputs", async (event) => {
    const query = new URL(event.req.url).searchParams;
    const { roomId, eventId, agent } = await messageId({
      roomId: query.get("roomId"),
      eventId: query.get("eventId"),
      agentId: query.get("agentId"),
    });
    const job = await inspectHostRequest(agent.client, roomId, eventId);
    if (!job || job.runId !== query.get("runId"))
      reject(404, "没有这份原运行交付。");
    const activity = await readHostActivity(agent.client, roomId, eventId);
    return {
      state: activity?.outputsState ?? "unconfirmed",
      outputs: activity?.outputs ?? [],
    };
  });
  app.get("/api/agent/output", async (event) => {
    const query = new URL(event.req.url).searchParams;
    const { roomId, eventId, agent } = await messageId({
      roomId: query.get("roomId"),
      eventId: query.get("eventId"),
      agentId: query.get("agentId"),
    });
    const job = await inspectHostRequest(agent.client, roomId, eventId);
    if (!job || job.runId !== query.get("runId"))
      reject(404, "没有这份原运行交付。");
    try {
      const outputs = JSON.parse(
        await readFile(
          resolve(
            jobLocation(agent.client, roomId, eventId).directory,
            "outputs.json",
          ),
          "utf8",
        ),
      ) as Array<Record<string, unknown>>;
      const output = outputs.find(
        (o) => o.reference === query.get("reference"),
      );
      if (
        !output ||
        typeof output.contentBase64 !== "string" ||
        output.contentBase64.length > 24 * 1024 * 1024
      )
        reject(404, "文件未回流或超过大小限制。");
      return output;
    } catch {
      reject(404, "这份成果当前不可读取。");
    }
  });
  app.post("/api/agent/outputs/retrieve", async (event) => {
    const body = await readBody<Record<string, unknown>>(event);
    const { roomId, eventId, agent } = await messageId(body);
    if (typeof body?.runId !== "string" || !/^[\da-f-]{36}$/i.test(body.runId))
      reject(400, "请选择原运行。");
    try {
      return await retrieveHostOutputs(
        agent.client,
        roomId,
        eventId,
        body.runId,
      );
    } catch (error) {
      reject(
        409,
        error instanceof HostRequestError
          ? error.message
          : "原成果尚未取回，请稍后核对；未重跑任务。",
      );
    }
  });
  app.get("/api/agent/status", async (event) => {
    const query = new URL(event.req.url).searchParams;
    const { roomId, eventId, agent } = await messageId({
      roomId: query.get("roomId"),
      eventId: query.get("eventId"),
      agentId: query.get("agentId"),
    });
    const job = await inspectHostRequest(agent.client, roomId, eventId);
    const active = await activeHostRequest();
    const outcome = await hostOutcome(agent.client, roomId, eventId);
    const own =
      active?.roomId === roomId &&
      active.eventId === eventId &&
      active.agentId === agent.id;
    const activity = own
      ? await readHostActivity(agent.client, roomId, eventId)
      : null;
    const pendingPermissions = (activity?.interactions ?? [])
      .filter((request: { status: string }) => request.status === "pending")
      .map((request: { id: string; title: string }) => ({
        id: request.id,
        title: request.title,
      }));
    return {
      job: job
        ? {
            ...job,
            error: ["replied", "skipped", "completed"].includes(job.state)
              ? null
              : (job.error ??
                outcome?.error ??
                outcome?.result?.reason ??
                null),
            state: own
              ? "running"
              : [
                    "replied",
                    "skipped",
                    "completed",
                    "failed",
                    "cancelled",
                  ].includes(job.state)
                ? job.state
                : (outcome?.result?.state ?? job.state),
          }
        : null,
      active: own,
      busy: Boolean(active),
      checkedAt: outcome?.checkedAt ?? null,
      error: outcome?.error ?? null,
      pendingPermissions,
      queueState: await hostQueueState(agent.id, roomId, eventId),
      queued: (await queuedHostRequests()).some(
        (q) =>
          q.roomId === roomId &&
          q.eventId === eventId &&
          q.agentId === agent.id,
      ),
    };
  });
  let pumping = false;
  setInterval(() => {
    if (!pumping) {
      pumping = true;
      void pumpHostQueue()
        .catch(() => {})
        .finally(() => {
          pumping = false;
        });
    }
  }, 3000).unref();
  app.all("/api/**", () => reject(404, "接口不存在。"));
  const assets = staticMiddleware({ dir: directory, dotfiles: false });
  app.all("/**", (event) =>
    assets(event.req, () => new Response("Not found", { status: 404 })),
  );

  const server = serve(app, {
    hostname: "127.0.0.1",
    port: configuration.WEB_PORT,
    silent: true,
    gracefulShutdown: false,
    maxRequestBodySize: 24 * 1024 * 1024,
    trustProxy: false,
  });
  await server.ready();
  console.log(`聊天室已就绪：${origin}`);
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      if (closing) return;
      closing = true;
      void server.close(true).then(() => process.exit(0));
    });
}

await main().catch(() => {
  console.error(
    "网页服务启动失败，请检查本地会话、宿主配置、Synapse 和端口设置。",
  );
  process.exitCode = 1;
});
