import { mkdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { type MatrixClient } from "matrix-js-sdk";
import { loadSessionFile } from "../src/local.js";
import { createMatrixClient } from "../src/matrix-client.js";
import { provisionIdentity } from "../src/identity.js";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  client: MatrixClient;
  hostConfigFile?: string;
}

const root = resolve(import.meta.dirname, "..");
function privateFile(value: unknown) {
  if (typeof value !== "string" || !value)
    throw new Error("AGENT_CONFIG_INVALID");
  const file = resolve(root, value);
  const within = relative(resolve(root, ".local"), file);
  if (!within || isAbsolute(within) || within.startsWith(".."))
    throw new Error("AGENT_CONFIG_INVALID");
  return file;
}

/** 本机宿主的身份与执行配置映射；房间成员关系始终读取 Matrix。 */
export async function loadAgentProfiles(): Promise<AgentProfile[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      await readFile(resolve(root, ".local/agents.json"), "utf8"),
    );
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
    raw = [
      {
        id: "assistant",
        name: "协作助手",
        description: "通用讨论与文字协作",
        sessionFile: ".local/matrix-peer-session.json",
        hostConfigFile: ".local/agent-host.env",
      },
    ];
  }
  if (!Array.isArray(raw) || !raw.length)
    throw new Error("AGENT_CONFIG_INVALID");
  const profiles: AgentProfile[] = [];
  for (const item of raw) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,49}$/u.test(item.id) ||
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name.length > 80 ||
      (item.description !== undefined &&
        (typeof item.description !== "string" || item.description.length > 240))
    ) {
      throw new Error("AGENT_CONFIG_INVALID");
    }
    const client = await loadSessionFile(privateFile(item.sessionFile));
    if (
      profiles.some(
        (profile) =>
          profile.id === item.id ||
          profile.client.getSafeUserId() === client.getSafeUserId(),
      )
    ) {
      throw new Error("AGENT_IDENTITIES_MUST_BE_DISTINCT");
    }
    profiles.push({
      id: item.id,
      name: item.name.trim(),
      description: item.description ?? "",
      client,
      ...(item.hostConfigFile === undefined
        ? {}
        : { hostConfigFile: privateFile(item.hostConfigFile) }),
    });
  }
  return profiles;
}

/** Explicit local host operation: create/reuse an AS identity, preserving its device and session. */
export async function ensureManagedAgent(input: {
  id: string;
  name: string;
  description: string;
}) {
  if (
    !/^[a-z][a-z0-9-]{0,49}$/u.test(input.id) ||
    !input.name.trim() ||
    input.name.length > 80 ||
    input.description.length > 240
  )
    throw new Error("AGENT_CONFIG_INVALID");
  const local = resolve(root, ".local");
  await mkdir(local, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(local);
  try {
    const profiles = await loadAgentProfiles();
    const existing = profiles.find((profile) => profile.id === input.id);
    let records: Array<{
      id: string;
      name: string;
      description: string;
      sessionFile: string;
      hostConfigFile?: string;
    }>;
    try {
      records = JSON.parse(
        await readFile(resolve(local, "agents.json"), "utf8"),
      );
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
      records = [
        {
          id: "assistant",
          name: "协作助手",
          description: "通用讨论与文字协作",
          sessionFile: ".local/matrix-peer-session.json",
          hostConfigFile: ".local/agent-host.env",
        },
      ];
    }
    if (existing) {
      if (
        existing.name !== input.name ||
        existing.description !== input.description
      ) {
        await existing.client.setDisplayName(input.name);
        await writeFileAtomic(
          resolve(local, "agents.json"),
          JSON.stringify(
            records.map((record) =>
              record.id === input.id
                ? {
                    ...record,
                    name: input.name,
                    description: input.description,
                  }
                : record,
            ),
            null,
            2,
          ),
          { mode: 0o600 },
        );
      }
      return { ...existing, name: input.name, description: input.description };
    }
    if (profiles.length >= 50) throw new Error("AGENT_LIMIT_REACHED");
    const hostConfigFile = profiles.find(
      (profile) => profile.hostConfigFile,
    )?.hostConfigFile;
    if (!hostConfigFile) throw new Error("AGENT_HOST_NOT_CONFIGURED");
    const sessionFile = resolve(local, `matrix-${input.id}-session.json`);
    let client: MatrixClient;
    try {
      client = await loadSessionFile(sessionFile);
    } catch (error) {
      // An existing invalid session is never overwritten or silently replaced.
      try {
        await stat(sessionFile);
        throw error;
      } catch (missing) {
        if (!(
          missing &&
          typeof missing === "object" &&
          "code" in missing &&
          missing.code === "ENOENT"
        ))
          throw missing;
      }
      const credentialFile = resolve(local, "application-service.json");
      const info = await stat(credentialFile);
      if (info.mode & 0o077)
        throw new Error("AGENT_SERVICE_CREDENTIAL_NOT_PRIVATE");
      const credential = JSON.parse(await readFile(credentialFile, "utf8"));
      if (
        typeof credential.baseUrl !== "string" ||
        typeof credential.accessToken !== "string"
      )
        throw new Error("AGENT_SERVICE_NOT_CONFIGURED");
      const service = createMatrixClient(credential);
      if (service.getHomeserverUrl() !== profiles[0]!.client.getHomeserverUrl())
        throw new Error("AGENT_SERVICE_MISMATCH");
      const session = await provisionIdentity(service, {
        localpart: `_mtc_${input.id.replaceAll("-", "_")}`,
        deviceId: `MTC_${input.id.toUpperCase()}`,
      });
      await writeFileAtomic(sessionFile, JSON.stringify(session), {
        mode: 0o600,
      });
      client = await loadSessionFile(sessionFile);
    }
    if (
      !client
        .getSafeUserId()
        .startsWith(`@_mtc_${input.id.replaceAll("-", "_")}:`)
    )
      throw new Error("AGENT_IDENTITY_MISMATCH");
    await client.setDisplayName(input.name);
    records.push({ ...input, sessionFile, hostConfigFile });
    await writeFileAtomic(
      resolve(local, "agents.json"),
      JSON.stringify(records, null, 2),
      { mode: 0o600 },
    );
    return { ...input, client, hostConfigFile };
  } finally {
    await release();
  }
}

export function publicAgent(agent: AgentProfile) {
  return {
    id: agent.id,
    userId: agent.client.getSafeUserId(),
    name: agent.name,
    description: agent.description,
    executable: Boolean(agent.hostConfigFile),
  };
}
