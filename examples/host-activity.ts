import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { resolve } from "node:path";
import type { MatrixClient } from "matrix-js-sdk";
import {
  jobLocation,
  inspectHostRequest,
  HostRequestError,
} from "./dock-host.js";

export async function readHostActivity(
  agent: MatrixClient,
  roomId: string,
  eventId: string,
) {
  const { directory } = jobLocation(agent, roomId, eventId);
  try {
    const value = JSON.parse(
      await readFile(resolve(directory, "activity.json"), "utf8"),
    );
    const job = await inspectHostRequest(agent, roomId, eventId);
    if (!job || value.runId !== job.runId || value.version !== 1) return null;
    const confirmed = ["replied", "completed", "skipped"].includes(job.state)
      ? "completed"
      : ["failed", "cancelled"].includes(job.state)
        ? job.state
        : null;
    if (confirmed && value.state !== confirmed) {
      value.state = confirmed;
      value.steering = false;
      value.interactions = value.interactions.map(
        (request: Record<string, unknown>) =>
          ["pending", "submitting"].includes(String(request.status))
            ? { ...request, status: "expired" }
            : request,
      );
      if (
        !value.finishedAt &&
        (!value.outputsState || value.outputsState === "pending")
      )
        value.outputsState = "unconfirmed";
    }
    value.outputsState ??= value.outputs?.length ? "available" : "none";
    // Output content lives behind a separate authenticated endpoint.
    return {
      ...value,
      outputs: (value.outputs ?? []).map(
        ({ contentBase64: _, ...metadata }: Record<string, unknown>) =>
          metadata,
      ),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new HostRequestError("原运行的过程暂不可读取。");
  }
}

export async function sendHostControl(
  agent: MatrixClient,
  roomId: string,
  eventId: string,
  input: {
    id: string;
    runId: string;
    kind: "steer" | "stop" | "respond";
    text?: string;
    requestId?: string;
    response?: unknown;
  },
  beforeAccept?: () => Promise<void>,
) {
  const { directory } = jobLocation(agent, roomId, eventId);
  const folder = resolve(directory, "commands");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify(input);
  const fingerprint = createHash("sha256").update(payload).digest("hex");
  const path = resolve(folder, `${input.id}.json`);
  const release = await lockfile.lock(folder, {
    retries: { retries: 5, minTimeout: 10, maxTimeout: 100 },
  });
  try {
    try {
      const original = JSON.parse(await readFile(path, "utf8"));
      if (original.fingerprint !== fingerprint)
        throw new HostRequestError("同一操作编号不能用于不同内容。");
      return { accepted: true, id: input.id, reused: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const activity = await readHostActivity(agent, roomId, eventId);
    if (
      !activity ||
      activity.runId !== input.runId ||
      activity.state !== "running"
    )
      throw new HostRequestError("原运行当前不能接收操作，请刷新核对。");
    if (input.kind === "steer" && !activity.steering)
      throw new HostRequestError("原运行当前不支持补充。");
    if (beforeAccept) await beforeAccept();
    // The SDK reader can only see a complete command, including after a crash.
    await writeFileAtomic(path, JSON.stringify({ ...input, fingerprint }), {
      mode: 0o600,
    });
    return { accepted: true, id: input.id, reused: false };
  } finally {
    await release();
  }
}
