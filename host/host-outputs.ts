import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { ServerClient, loadClientOptions } from "@harness-dock/client";
import type { MatrixClient } from "matrix-js-sdk";
import {
  HostRequestError,
  inspectHostRequest,
  jobLocation,
} from "./dock-host.js";
import { activeHostRequest } from "./host-worker.js";

/** Read-only collection from the original run. Never prepares or executes again. */
export async function retrieveHostOutputs(
  agent: MatrixClient,
  roomId: string,
  eventId: string,
  runId: string,
) {
  const job = await inspectHostRequest(agent, roomId, eventId);
  if (
    !job ||
    job.runId !== runId ||
    !["replied", "completed", "failed", "cancelled"].includes(job.state)
  )
    throw new HostRequestError("请先确认原运行已结束。");
  if (await activeHostRequest())
    throw new HostRequestError("执行入口正在使用，请稍后补取原成果。");
  const { directory } = jobLocation(agent, roomId, eventId);
  const release = await lockfile.lock(
    resolve(import.meta.dirname, "../.local/agent-host"),
  );
  let client: ServerClient | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const receipt = JSON.parse(
      await readFile(resolve(directory, "dock-receipt.json"), "utf8"),
    );
    const options = await loadClientOptions(
      resolve(directory, "dock-client.json"),
    );
    if (
      receipt.clientId !== options.clientId ||
      receipt.runId !== runId ||
      receipt.nodeId !== job.nodeId
    )
      throw new HostRequestError("原成果的执行身份不一致。");
    client = new ServerClient(options);
    await Promise.race([
      client.ready,
      new Promise((_, reject) => {
        readyTimer = setTimeout(
          () => reject(new HostRequestError("原执行连接尚未确认。")),
          5000,
        );
      }),
    ]);
    clearTimeout(readyTimer);
    const peer = client.node(receipt.nodeId);
    if (!peer?.connected) throw new HostRequestError("原执行设备当前离线。");
    const original = await peer.request("getExecution", { runId }, 5000);
    if (
      !original ||
      original.runId !== runId ||
      !["completed", "failed", "cancelled"].includes(original.state)
    )
      throw new HostRequestError("原运行终态尚未确认。");
    const outputs = await peer.request("collect", { runId }, 8000);
    await writeFileAtomic(
      resolve(directory, "outputs.json"),
      JSON.stringify(outputs),
      { mode: 0o600 },
    );
    const activity = JSON.parse(
      await readFile(resolve(directory, "activity.json"), "utf8"),
    );
    if (activity.runId !== runId)
      throw new HostRequestError("原过程与成果不一致。");
    activity.outputs = outputs.map(
      ({ contentBase64: _, ...metadata }) => metadata,
    );
    activity.outputsState = outputs.length ? "available" : "none";
    activity.revision++;
    await writeFileAtomic(
      resolve(directory, "activity.json"),
      JSON.stringify(activity),
      { mode: 0o600 },
    );
    return { count: outputs.length };
  } finally {
    clearTimeout(readyTimer);
    await client?.close();
    await release();
  }
}
