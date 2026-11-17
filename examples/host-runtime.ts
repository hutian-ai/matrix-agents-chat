import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { ServerClient, loadClientOptions } from "@harness-dock/client";
import { runtimeInventory } from "./runtime-inventory.mjs";
import { activeHostRequest } from "./host-worker.js";
import { jobLocation, HostRequestError } from "./dock-host.js";
import type { AgentProfile } from "./agents.js";

const root = resolve(import.meta.dirname, "..");
export async function readHostRuntime(
  clientId: string,
  nodeId: string | undefined,
  agents: AgentProfile[],
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const active = await activeHostRequest();
    if (active) {
      const agent = agents.find((a) => a.id === active.agentId);
      if (!agent) throw new HostRequestError("当前执行入口的身份尚未确认。");
      const directory = jobLocation(
        agent.client,
        active.roomId,
        active.eventId,
      ).directory;
      const options = await loadClientOptions(
        resolve(directory, "dock-client.json"),
      );
      if (options.clientId !== clientId)
        throw new HostRequestError("当前工作使用另一连接，未借用其设备范围。");
      const folder = resolve(directory, "runtime-queries");
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      await writeFileAtomic(
        resolve(folder, `${id}.request.json`),
        JSON.stringify({ clientId, nodeId }),
        { mode: 0o600 },
      );
      for (let poll = 0; poll < 55; poll++) {
        try {
          const result = JSON.parse(
            await readFile(resolve(folder, `${id}.response.json`), "utf8"),
          );
          if (result.error)
            throw new HostRequestError(
              "执行连接上的设备读取尚未确认，请稍后刷新。",
            );
          await Promise.all(
            ["request", "response"].map((kind) =>
              rm(resolve(folder, `${id}.${kind}.json`), { force: true }),
            ),
          );
          return result;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!(await activeHostRequest())) break;
        await delay(200);
      }
      if (await activeHostRequest())
        throw new HostRequestError(
          "原工作正在运行，设备列表暂未确认；不需要重新配置连接。",
        );
      continue;
    }
    const folder = resolve(root, ".local/agent-host");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(folder, {
      retries: { retries: 3, minTimeout: 50, maxTimeout: 150 },
    });
    let client: ServerClient | undefined;
    try {
      if (await activeHostRequest()) continue;
      const mappings = JSON.parse(
        await readFile(resolve(root, ".local/host-connections.json"), "utf8"),
      );
      if (typeof mappings.workspace !== "string")
        throw new HostRequestError("执行入口尚未配置工作台连接。");
      const options = await loadClientOptions(
        resolve(root, mappings.workspace),
      );
      if (options.clientId !== clientId)
        throw new HostRequestError(
          "页面与执行入口的连接身份不一致，请核对本机连接映射。",
        );
      client = new ServerClient({ ...options, connectTimeoutMs: 6000 });
      await client.ready;
      return { clientId, ...(await runtimeInventory(client, nodeId)) };
    } finally {
      await client?.close();
      await release();
    }
  }
  throw new HostRequestError("执行连接状态已改变，请刷新原入口。");
}
