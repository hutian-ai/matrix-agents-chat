import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { defineCommand, runMain } from "citty";
import lockfile from "proper-lockfile";
import { x } from "tinyexec";
import writeFileAtomic from "write-file-atomic";
import { type MatrixClient } from "matrix-js-sdk";
import { loadAgentProfiles, type AgentProfile } from "./agents.js";
import {
  HostRequestError,
  jobLocation,
  runHostRequest,
  type HostResult,
  type HostContext,
} from "./dock-host.js";

const root = resolve(import.meta.dirname, "..");
const directory = resolve(root, ".local/host-worker");
const execution = resolve(directory, "execution");
interface Operation {
  id: string;
  agentId: string;
  userId: string;
  deviceId: string | null;
  roomId: string;
  eventId: string;
  resumeOnly: boolean;
  context?: HostContext;
}
interface Outcome {
  operationId: string;
  checkedAt: number;
  result?: HostResult;
  error?: string;
}
interface Queued extends Operation {
  state: "queued" | "paused" | "dispatched" | "cancelled";
  createdAt: number;
  predecessor?: Operation | undefined;
}
const queueDirectory = resolve(directory, "queue");

export async function queuedHostRequests() {
  await mkdir(queueDirectory, { recursive: true, mode: 0o700 });
  const entries = await Promise.all(
    (await readdir(queueDirectory))
      .filter((n) => /^[\da-f-]{36}\.json$/i.test(n))
      .map((n) => readJson<Queued>(resolve(queueDirectory, n))),
  );
  return entries
    .filter((q): q is Queued =>
      Boolean(q && ["queued", "paused"].includes(q.state)),
    )
    .sort((a, b) => a.createdAt - b.createdAt);
}
export async function hostQueueState(
  agentId: string,
  roomId: string,
  eventId: string,
) {
  await mkdir(queueDirectory, { recursive: true, mode: 0o700 });
  for (const name of await readdir(queueDirectory)) {
    if (!/^[\da-f-]{36}\.json$/i.test(name)) continue;
    const item = await readJson<Queued>(resolve(queueDirectory, name));
    if (
      item?.agentId === agentId &&
      item.roomId === roomId &&
      item.eventId === eventId
    )
      return item.state;
  }
  return null;
}

export async function changeQueuedRequest(
  id: string,
  roomId: string,
  action: "cancel" | "start",
) {
  const path = resolve(queueDirectory, `${id}.json`);
  const release = await lockfile.lock(directory);
  try {
    const item = await readJson<Queued>(path);
    if (
      !item ||
      item.roomId !== roomId ||
      !["queued", "paused"].includes(item.state)
    )
      throw new HostRequestError("排队项已改变，请刷新。");
    item.state = action === "cancel" ? "cancelled" : "queued";
    if (action === "start") delete item.predecessor;
    await writeFileAtomic(path, JSON.stringify(item), { mode: 0o600 });
  } finally {
    await release();
  }
}

export async function pumpHostQueue() {
  if (await activeHostRequest()) return;
  const profiles = await loadAgentProfiles();
  for (const item of await queuedHostRequests()) {
    if (item.state !== "queued") continue;
    const agent = profiles.find(
      (a) =>
        a.id === item.agentId &&
        a.client.getSafeUserId() === item.userId &&
        a.client.getDeviceId() === item.deviceId,
    );
    if (!agent) continue;
    let continuationReplyId: string | undefined;
    if (item.predecessor) {
      const previousAgent = profiles.find(
        (a) => a.id === item.predecessor!.agentId,
      );
      const result = previousAgent
        ? await hostOutcome(
            previousAgent.client,
            item.predecessor.roomId,
            item.predecessor.eventId,
          )
        : null;
      if (
        result?.result?.state !== "replied" &&
        result?.result?.state !== "skipped"
      ) {
        item.state = "paused";
        await writeFileAtomic(
          resolve(queueDirectory, `${item.id}.json`),
          JSON.stringify(item),
          { mode: 0o600 },
        );
        continue;
      }
      if (typeof result.result.replyEventId === "string")
        continuationReplyId = result.result.replyEventId;
    }
    try {
      await launchHostRequest(
        agent,
        item.roomId,
        item.eventId,
        item.resumeOnly,
        continuationReplyId
          ? { ...item.context, continuationReplyId }
          : item.context,
      );
      item.state = "dispatched";
      await writeFileAtomic(
        resolve(queueDirectory, `${item.id}.json`),
        JSON.stringify(item),
        { mode: 0o600 },
      );
    } catch {
      /* Preserve the original intent. No alternate run is created. */
    }
    return;
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return null;
    throw error;
  }
}

/** 活动信息只有在宿主执行锁仍有效时才显示；历史文件不被当作存活的进程。 */
export async function activeHostRequest() {
  if (
    !(await lockfile.check(execution).catch((error) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return false;
      throw error;
    }))
  )
    return null;
  return readJson<Operation>(resolve(directory, "active.json"));
}

export async function hostOutcome(
  agent: MatrixClient,
  roomId: string,
  eventId: string,
) {
  const folder = jobLocation(agent, roomId, eventId).directory;
  const outcome = await readJson<Outcome>(resolve(folder, "observation.json"));
  // Explain legacy cancellations from the original activity, without rewriting the receipt.
  if (outcome?.result?.state === "cancelled" && !outcome.result.reason) {
    const activity = await readJson<{
      runId: string;
      interactions?: { decision?: unknown }[];
    }>(resolve(folder, "activity.json"));
    if (
      activity?.runId === outcome.result.runId &&
      activity.interactions?.some((request) => request.decision === "deny")
    ) {
      return {
        ...outcome,
        result: {
          ...outcome.result,
          reason: "原生权限请求被拒绝，本轮已取消；未放宽原有审批策略。",
        },
      };
    }
  }
  return outcome;
}

/** 网页只启动独立宿主，不持有 Dock 应用连接；进程日志与结果均直接落到私有文件。 */
export async function launchHostRequest(
  agent: AgentProfile,
  roomId: string,
  eventId: string,
  resumeOnly: boolean,
  context?: HostContext,
) {
  await mkdir(execution, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(directory);
  try {
    const active = await activeHostRequest();
    if (active) {
      if (
        active.agentId === agent.id &&
        active.roomId === roomId &&
        active.eventId === eventId
      )
        return;
      if (!context?.interactive)
        throw new HostRequestError(
          "助手正在处理另一条消息，请等待原任务结束。",
        );
      const queue = await queuedHostRequests();
      const existing = queue.find(
        (q) =>
          q.agentId === agent.id &&
          q.roomId === roomId &&
          q.eventId === eventId,
      );
      if (!existing) {
        const item: Queued = {
          id: randomUUID(),
          agentId: agent.id,
          userId: agent.client.getSafeUserId(),
          deviceId: agent.client.getDeviceId(),
          roomId,
          eventId,
          resumeOnly,
          context,
          state: "queued",
          createdAt: Date.now(),
          predecessor:
            queue.findLast(
              (q) => q.roomId === roomId && q.agentId === agent.id,
            ) ??
            (active.roomId === roomId && active.agentId === agent.id
              ? active
              : undefined),
        };
        await writeFileAtomic(
          resolve(queueDirectory, `${item.id}.json`),
          JSON.stringify(item),
          { mode: 0o600 },
        );
      }
      return;
    }
    const operation: Operation = {
      id: randomUUID(),
      agentId: agent.id,
      userId: agent.client.getSafeUserId(),
      deviceId: agent.client.getDeviceId(),
      roomId,
      eventId,
      resumeOnly,
      ...(context ? { context } : {}),
    };
    const requestFile = resolve(directory, `${operation.id}.json`);
    await writeFileAtomic(requestFile, JSON.stringify(operation), {
      mode: 0o600,
    });
    const log = await open(
      resolve(directory, `${operation.id}.log`),
      "a",
      0o600,
    );
    const child = x(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve(import.meta.dirname, "host-worker.ts"),
        "--operation",
        operation.id,
      ],
      {
        persist: true,
        nodeOptions: { cwd: root, stdio: ["ignore", log.fd, log.fd] },
      },
    );
    child.process?.unref();
    await log.close();
    for (let attempt = 0; attempt < 100; attempt++) {
      const [running, outcome] = await Promise.all([
        activeHostRequest(),
        readJson<Outcome>(resolve(directory, `${operation.id}.result.json`)),
      ]);
      if (outcome?.operationId === operation.id) {
        if (outcome.error) throw new HostRequestError(outcome.error);
        return;
      }
      if (running?.id === operation.id) return;
      if (child.exitCode !== undefined || child.process?.exitCode !== null)
        break;
      await delay(50);
    }
    // 不终止未知启动状态的宿主，后续仍按原消息 / 回执核对。
    throw new HostRequestError(
      "宿主启动尚未确认，请查看原消息状态；未终止或替换原运行。",
    );
  } finally {
    await release();
  }
}

export const main = defineCommand({
  meta: {
    name: "chat-host-worker",
    description: "独立持有聊天任务的 Dock 应用连接与交付过程",
  },
  args: {
    operation: {
      type: "string",
      required: true,
      description: "本机已记录的操作 ID",
    },
  },
  async run({ args }) {
    if (!/^[\da-f-]{36}$/u.test(args.operation)) {
      process.exitCode = 1;
      return;
    }
    let operation: Operation | null = null;
    let agent: AgentProfile | undefined;
    let release: (() => Promise<void>) | undefined;
    const outcome: Outcome = {
      operationId: args.operation,
      checkedAt: Date.now(),
    };
    try {
      operation = await readJson<Operation>(
        resolve(directory, `${args.operation}.json`),
      );
      if (!operation || operation.id !== args.operation)
        throw new HostRequestError("宿主操作记录不完整，未派发。");
      agent = (await loadAgentProfiles()).find(
        (profile) => profile.id === operation!.agentId,
      );
      if (
        !agent ||
        agent.client.getSafeUserId() !== operation.userId ||
        agent.client.getDeviceId() !== operation.deviceId
      ) {
        throw new HostRequestError("助手身份配置已改变，未派发或替换原运行。");
      }
      release = await lockfile.lock(execution);
      await writeFileAtomic(
        resolve(directory, "active.json"),
        JSON.stringify(operation),
        { mode: 0o600 },
      );
      outcome.result = await runHostRequest({
        agent,
        event: operation.eventId,
        room: operation.roomId,
        resumeOnly: operation.resumeOnly,
        ...(operation.context ? { context: operation.context } : {}),
      });
    } catch (error) {
      outcome.error =
        error instanceof HostRequestError
          ? error.message
          : "宿主操作未完成，请按原消息与回执核对。";
      process.exitCode = 1;
    } finally {
      outcome.checkedAt = Date.now();
      try {
        if (agent && operation) {
          const job = jobLocation(
            agent.client,
            operation.roomId,
            operation.eventId,
          );
          await mkdir(job.directory, { recursive: true, mode: 0o700 });
          await writeFileAtomic(
            resolve(job.directory, "observation.json"),
            JSON.stringify(outcome),
            { mode: 0o600 },
          );
        }
        await writeFileAtomic(
          resolve(directory, `${args.operation}.result.json`),
          JSON.stringify(outcome),
          { mode: 0o600 },
        );
      } finally {
        await release?.();
      }
    }
  },
});

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await runMain(main);
