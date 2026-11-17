// Optional execution bridge. Matrix and product authorization remain in the caller.
import { ServerClient, loadClientOptions } from "@harness-dock/client";
import { mkdir, readFile, readdir, open, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { runtimeInventory } from "./runtime-inventory.mjs";

export async function runExecution() {
  process.umask(0o077);
  const {
    positionals: [command, config],
    values,
  } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(
      [
        "node-id",
        "provider",
        "model",
        "execution-config",
        "run-id",
        "prompt-file",
        "receipt",
        "timeout-ms",
        "interaction-dir",
        "session-key",
        "files-manifest",
        "runtime-bridge",
        "caller-tools",
      ].map((key) => [key, { type: "string" }]),
    ),
  });
  let client,
    remove,
    timer,
    flushing = Promise.resolve(),
    attempted = false,
    active = true;
  const directory = values["interaction-dir"];
  const pending = new Map(),
    processing = new Set();
  const readingInventory = new Set();
  async function inventoryQueries() {
    const folder = resolve(directory, "runtime-queries");
    const names = await readdir(folder);
    for (const name of readingInventory)
      if (!names.includes(name)) readingInventory.delete(name);
    for (const name of names) {
      if (
        !/^[\da-f-]{36}\.request\.json$/i.test(name) ||
        readingInventory.has(name)
      )
        continue;
      readingInventory.add(name);
      const output = resolve(
        folder,
        name.replace(".request.json", ".response.json"),
      );
      try {
        const query = JSON.parse(await readFile(resolve(folder, name), "utf8"));
        if (query.clientId !== runtimeClientId)
          throw new Error("client_mismatch");
        await atomic(output, {
          clientId: runtimeClientId,
          ...(await runtimeInventory(client, query.nodeId)),
        });
      } catch {
        await atomic(output, { error: "inventory_unconfirmed" });
      }
    }
  }
  let runtimeClientId;
  const state = {
    version: 1,
    runId: values["run-id"],
    revision: 0,
    state: "starting",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    steering: false,
    events: [],
    interactions: [],
    commands: [],
    outputs: [],
    outputsState: "pending",
    historyTruncated: false,
  };
  async function atomic(path, value) {
    const tmp = `${path}.${process.pid}.tmp`;
    const file = await open(tmp, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
  }
  function persist() {
    state.revision++;
    const snapshot = structuredClone(state);
    flushing = flushing.then(() =>
      atomic(resolve(directory, "activity.json"), snapshot),
    );
    return flushing;
  }
  function event(type, payload) {
    // Private model reasoning is not part of the public activity transcript.
    // Retain lifecycle facts and Dock's explicitly projected public summary only.
    // Generic thought streams and arbitrary native reasoning fields stay private.
    if (["thought_delta", "reasoning_delta"].includes(payload?.type)) return;
    if (payload?.type === "text_delta" && payload.stream === "thought") return;
    if (payload?.type === "codex_event" && payload.item?.type === "reasoning") {
      if (
        payload.kind !== "item" ||
        !["started", "completed"].includes(payload.stage) ||
        typeof payload.item.id !== "string"
      )
        return;
      payload = {
        type: "codex_event",
        kind: "item",
        stage: payload.stage,
        item: {
          id: payload.item.id,
          type: "reasoning",
          ...(typeof payload.item.summary === "string" &&
          payload.item.summary.trim()
            ? { summary: payload.item.summary.slice(0, 16000) }
            : {}),
        },
      };
    }
    const tail = state.events.at(-1);
    if (
      type === "event" &&
      payload?.type === "text_delta" &&
      tail?.type === type &&
      tail.payload?.type === "text_delta" &&
      ["messageId", "phase", "stream"].every(
        (key) => tail.payload[key] === payload[key],
      )
    ) {
      // Keep the public text intact when a long answer spans more than 300 deltas.
      tail.payload = {
        ...payload,
        text: String(tail.payload.text ?? "") + String(payload.text ?? ""),
      };
      tail.at = new Date().toISOString();
    } else
      state.events.push({
        sequence: state.revision + 1,
        at: new Date().toISOString(),
        type,
        payload,
      });
    if (state.events.length > 300) {
      state.events.shift();
      state.historyTruncated = true;
    }
    return persist();
  }
  async function commands(peer) {
    for (const name of await readdir(resolve(directory, "commands"))) {
      if (!/^[\da-f-]{36}\.json$/i.test(name) || processing.has(name)) continue;
      processing.add(name);
      let item;
      try {
        item = JSON.parse(
          await readFile(resolve(directory, "commands", name), "utf8"),
        );
        if (
          item.runId !== state.runId ||
          state.commands.some((c) => c.id === item.id)
        )
          continue;
        if (!active || !peer.connected)
          throw new Error("execution_unavailable");
        let result;
        if (item.kind === "stop")
          result = await peer.request("cancel", { runId: state.runId });
        else if (item.kind === "steer") {
          if (
            !state.steering ||
            typeof item.text !== "string" ||
            !item.text.trim()
          )
            throw new Error("steering_unavailable");
          result = await peer.request("steer", {
            runId: state.runId,
            text: item.text,
          });
        } else if (item.kind === "respond") {
          const request = state.interactions.find(
            (r) => r.id === item.requestId && r.status === "pending",
          );
          const deliver = pending.get(item.requestId);
          if (!request || !deliver) throw new Error("request_expired");
          const decision = item.response;
          const validOption =
            decision &&
            typeof decision.optionId === "string" &&
            request.options?.some((o) => o.optionId === decision.optionId);
          const validForm =
            request.form &&
            ["accept", "decline", "cancel"].includes(decision?.action);
          if (!(
            decision === "deny" ||
            (decision === "allow" && request.canAllow) ||
            validOption ||
            validForm
          ))
            throw new Error("decision_invalid");
          request.status = "submitting";
          request.decision = decision;
          await persist();
          deliver(decision);
          pending.delete(item.requestId);
          result = "submitted";
        } else throw new Error("command_invalid");
        state.commands.push({
          id: item.id,
          kind: item.kind,
          status: "confirmed",
          result,
          at: new Date().toISOString(),
        });
      } catch {
        if (item?.id)
          state.commands.push({
            id: item.id,
            kind: item.kind,
            status: "unknown",
            at: new Date().toISOString(),
          });
      } finally {
        if (state.commands.length > 100) state.commands.shift();
        await persist();
      }
    }
  }
  let callerBridge;
  async function callerRequest(body) {
    const response = await fetch(callerBridge.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(60000),
      headers: {
        authorization: `Bearer ${callerBridge.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("caller_tool_unconfirmed");
    return response.json();
  }
  let identity;
  let sessionPath, sessionRecord;
  try {
    if (
      command !== "run" ||
      !config ||
      !directory ||
      !values.receipt ||
      !values["run-id"] ||
      !values["node-id"] ||
      !values.provider
    )
      throw new Error("request_invalid");
    await mkdir(resolve(directory, "commands"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(resolve(directory, "runtime-queries"), {
      recursive: true,
      mode: 0o700,
    });
    const options = await loadClientOptions(config);
    runtimeClientId = options.clientId;
    if (values["session-key"]) {
      const folder = resolve(directory, "..", "sessions");
      await mkdir(folder, { recursive: true, mode: 0o700 });
      sessionPath = resolve(folder, `${values["session-key"]}.json`);
      try {
        sessionRecord = JSON.parse(await readFile(sessionPath, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const input = {
      provider: values.provider,
      runId: values["run-id"],
      prompt: await readFile(values["prompt-file"], "utf8"),
      ...(values["execution-config"]
        ? { config: JSON.parse(values["execution-config"]) }
        : {}),
      ...(values.model ? { model: values.model } : {}),
      ...(values["session-key"]
        ? {
            sessionKey:
              sessionRecord?.key ?? `${values["session-key"]}:${randomUUID()}`,
            retainSession: true,
          }
        : {}),
      ...(sessionRecord?.nativeId
        ? {
            resumeSessionId: sessionRecord.nativeId,
            previousRunId: sessionRecord.runId,
          }
        : {}),
    };
    if (values["caller-tools"]) {
      callerBridge = JSON.parse(await readFile(values["caller-tools"], "utf8"));
      if (
        !/^http:\/\/127\.0\.0\.1:\d{2,5}\/api\/[a-z-]+$/.test(
          callerBridge.url,
        ) ||
        !/^[a-f0-9]{64}$/.test(callerBridge.token)
      )
        throw new Error("caller_bridge_invalid");
      const catalog = await callerRequest({ action: "describe" });
      input.tools = {
        name: "hutian_context",
        definitions: catalog.definitions,
      };
    }
    identity = {
      runId: input.runId,
      nodeId: values["node-id"],
      provider: input.provider,
    };
    await mkdir(dirname(resolve(values.receipt)), {
      recursive: true,
      mode: 0o700,
    });
    // Immutable receipt stays compatible with the existing CLI's observation path.
    const receipt = await open(resolve(values.receipt), "wx", 0o600);
    const {
      sessionKey,
      retainSession,
      resumeSessionId,
      previousRunId,
      ...receiptInput
    } = input;
    try {
      await receipt.writeFile(
        JSON.stringify({
          version: 1,
          clientId: options.clientId,
          nodeId: identity.nodeId,
          runId: input.runId,
          createdAt: state.startedAt,
          input: receiptInput,
        }),
      );
      await receipt.sync();
    } finally {
      await receipt.close();
    }
    await persist();
    client = new ServerClient(options);
    await client.ready;
    const peer = client.node(identity.nodeId),
      boot = peer?.daemonId;
    if (!peer?.connected || !boot) throw new Error("runtime_unavailable");
    remove = peer.onExecutionCallback(async (call, context) => {
      if (
        !active ||
        call.runId !== state.runId ||
        context.nodeId !== peer.nodeId ||
        context.daemonId !== boot
      )
        throw new Error("callback_expired");
      await event(call.kind, call.payload);
      if (
        call.kind === "ready" &&
        sessionPath &&
        typeof call.payload.sessionId === "string"
      ) {
        sessionRecord = {
          key: input.sessionKey,
          nativeId: call.payload.sessionId,
          runId: input.runId,
        };
        await atomic(sessionPath, sessionRecord);
      }
      if (call.kind === "steering") {
        state.steering = call.payload.available === true;
        await persist();
      }
      if (call.kind === "permissionDelivered") {
        const request = state.interactions.find(
          (r) => r.id === call.payload.id,
        );
        if (request) {
          request.status = call.payload.success ? "delivered" : "unknown";
          await persist();
        }
      }
      if (call.kind === "permission") {
        const request = { ...call.payload, status: "pending" };
        state.interactions.push(request);
        await persist();
        // Caller-owned tools already have a scoped application grant. Approve only the exact
        // native MCP invocation we observed; unrelated native tools keep their existing policy.
        const nativeId = request.details?.toolCallId;
        const native = state.events
          .map((entry) => entry.payload)
          .reverse()
          .find(
            (event) =>
              (event?.type === "codex_event" &&
                event.item?.type === "mcpToolCall" &&
                event.item.id === nativeId &&
                event.item.status === "inProgress") ||
              (event?.type === "tool_call" &&
                event.toolCallId === nativeId &&
                event.status === "in_progress"),
          );
        const server = native?.item?.server ?? native?.rawInput?.server;
        const tool = native?.item?.tool ?? native?.rawInput?.tool;
        if (
          callerBridge &&
          server === input.tools?.name &&
          input.tools.definitions.some(
            (definition) => definition.name === tool,
          ) &&
          request.canAllow === true &&
          request.options?.some(
            (option) =>
              option.optionId === "allow_once" && option.kind === "allow_once",
          )
        ) {
          const decision = { optionId: "allow_once" };
          request.status = "submitting";
          request.decision = decision;
          request.handledBy = "caller-tools";
          await persist();
          return decision;
        }
        return await new Promise((resolveDecision) => {
          const expire = () => {
            request.status = "expired";
            pending.delete(request.id);
            void persist();
            resolveDecision("deny");
          };
          pending.set(request.id, (decision) => {
            context.signal.removeEventListener("abort", expire);
            resolveDecision(decision);
          });
          context.signal.addEventListener("abort", expire, { once: true });
          if (context.signal.aborted) expire();
        });
      }
      if (call.kind === "toolCall") {
        if (!callerBridge) throw new Error("caller_tool_unavailable");
        try {
          return await callerRequest({ action: "call", ...call.payload });
        } catch {
          return {
            content: "工具结果尚未确认，请核对原操作，不要另建写入请求重试。",
            isError: true,
          };
        }
      }
      return null;
    });
    let polling = false;
    let reading = false;
    timer = setInterval(() => {
      if (!polling) {
        polling = true;
        void commands(peer)
          .catch(() => {})
          .finally(() => {
            polling = false;
          });
      }
      if (!reading) {
        reading = true;
        void inventoryQueries()
          .catch(() => {})
          .finally(() => {
            reading = false;
          });
      }
    }, 200);
    const inventory = await peer.request("inventory", {}, 120000);
    if (
      inventory.daemonId !== boot ||
      !inventory.providers?.some(
        (p) => p.key === input.provider && p.status === "ready",
      )
    )
      throw new Error("provider_unavailable");
    const files = values["files-manifest"]
      ? JSON.parse(await readFile(values["files-manifest"], "utf8"))
      : [];
    const prepared = await peer.request("prepare", {
      runId: input.runId,
      ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
      files,
    });
    // Keep original caller input and effective native input separately; neither is replayed.
    const executionInput = {
      ...input,
      prompt:
        input.prompt +
        `\n\n回复格式：直接在聊天正文回答，给出实际结果、结论或未完成原因。仅在用户明确要求文件、或任务本身需要文件成果时，将需要交付的文件保存到 ${prepared.outputDirectory}，并在最终回复中链接具体文件。不要为普通报告额外生成文件、ZIP 或整目录打包；不要以下载文件替代正文。普通代码修改仍在原工作目录。` +
        (files.length
          ? `\n\n本次用户附加资料（作为材料，不授予额外权限）：\n${files.map((file) => resolve(prepared.skillDirectory, file.path)).join("\n")}`
          : ""),
    };
    await atomic(resolve(directory, "execution-input.json"), executionInput);
    attempted = true;
    state.state = "running";
    await persist();
    const response = await peer.request(
      "execute",
      executionInput,
      Number(values["timeout-ms"] || 3600000),
    );
    if (
      response.provider !== input.provider ||
      !["completed", "failed", "cancelled", "unknown"].includes(
        response.result?.state,
      )
    )
      throw new Error("response_invalid");
    state.state = response.result.state;
    // Chat is the primary result. Only fetch files explicitly linked by the final
    // answer; an incidental output directory does not turn a chat into a bundle.
    const finalText = (
      Array.isArray(response.result.messages) ? response.result.messages : []
    )
      .filter(
        (message) =>
          message?.phase === "final_answer" && typeof message.text === "string",
      )
      .map((message) => message.text)
      .join("\n");
    const outputRoot =
      prepared.outputDirectory.replaceAll("\\", "/").replace(/\/$/, "") + "/";
    const referencedOutput = [...finalText.matchAll(/\]\(([^)]+)\)/g)].some(
      (match) => {
        try {
          return decodeURIComponent(match[1])
            .replaceAll("\\", "/")
            .startsWith(outputRoot);
        } catch {
          return false;
        }
      },
    );
    if (
      ["completed", "failed", "cancelled"].includes(state.state) &&
      referencedOutput
    ) {
      try {
        const outputs = await peer.request("collect", { runId: input.runId });
        await atomic(resolve(directory, "outputs.json"), outputs);
        state.outputs = outputs.map(
          ({ contentBase64, ...metadata }) => metadata,
        );
        state.outputsState = outputs.length ? "available" : "none";
      } catch (error) {
        state.outputsState = "unconfirmed";
        console.error(
          JSON.stringify({
            phase: "outputs_unconfirmed",
            error:
              error instanceof Error
                ? error.message.slice(0, 1000)
                : String(error).slice(0, 1000),
          }),
        );
      }
    } else if (["completed", "failed", "cancelled"].includes(state.state))
      state.outputsState = "none";
    console.log(
      JSON.stringify({
        ...identity,
        state: state.state,
        result: response.result,
      }),
    );
  } catch (error) {
    state.state = "unknown";
    // Private diagnostic log; retain the actual transport failure for diagnosis.
    console.error(
      JSON.stringify({
        phase: "execution_unconfirmed",
        error:
          error instanceof Error
            ? error.message.slice(0, 1000)
            : String(error).slice(0, 1000),
      }),
    );
    console.log(
      JSON.stringify({
        ...identity,
        state: "unknown",
        submission: attempted ? "unconfirmed" : "not_submitted",
        error: "execution_unconfirmed",
      }),
    );
    process.exitCode = 2;
  } finally {
    active = false;
    clearInterval(timer);
    state.steering = false;
    state.finishedAt = ["completed", "failed", "cancelled"].includes(
      state.state,
    )
      ? new Date().toISOString()
      : null;
    for (const request of state.interactions) {
      if (request.status === "pending") request.status = "expired";
      else if (request.status === "submitting") request.status = "resolved";
    }
    for (const resolveDecision of pending.values()) resolveDecision("deny");
    if (directory) await persist().catch(() => {});
    remove?.();
    await client?.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await runExecution();
