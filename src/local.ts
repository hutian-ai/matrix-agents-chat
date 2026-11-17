import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cleanEnv, str, url } from "envalid";
import { type MatrixClient } from "matrix-js-sdk";
import { createMatrixClient } from "./matrix-client.js";

const reporter = ({ errors }: { errors: Record<string, unknown> }) => {
  if (Object.keys(errors).length > 0) throw new Error("LOCAL_CONFIG_INVALID");
};

async function readPrivateJson(fileName: string) {
  try {
    return JSON.parse(
      await readFile(`${import.meta.dirname}/../.local/${fileName}`, "utf8"),
    );
  } catch {
    throw new Error("LOCAL_CONFIG_INVALID");
  }
}

export async function loadLocalClient(peer = false, profile?: string) {
  if (
    profile !== undefined &&
    (peer || !/^[a-z][a-z0-9-]{0,49}$/u.test(profile))
  )
    throw new Error("LOCAL_PROFILE_INVALID");
  const file =
    profile === undefined
      ? peer
        ? "matrix-peer-session.json"
        : "matrix-session.json"
      : `matrix-${profile}-session.json`;
  return loadSessionFile(resolve(import.meta.dirname, "../.local", file));
}

/** 仅供可信的本机 CLI / 宿主读取指定会话，不接受网页传入的路径。 */
export async function loadSessionFile(fileName: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(fileName, "utf8"));
  } catch {
    throw new Error("LOCAL_CONFIG_INVALID");
  }
  const { baseUrl, userId, deviceId, accessToken } = cleanEnv(
    raw,
    {
      baseUrl: url(),
      userId: str(),
      deviceId: str(),
      accessToken: str(),
    },
    { reporter },
  );
  const client = createMatrixClient({ baseUrl, userId, deviceId, accessToken });
  const identity = await client.whoami();
  if (identity.user_id !== userId || identity.device_id !== deviceId) {
    throw new Error("LOCAL_CONFIG_INVALID");
  }
  return client;
}

export async function loadLocalRoom(client: MatrixClient) {
  const raw = await readPrivateJson("matrix-room.json");
  const { baseUrl, roomId } = cleanEnv(
    raw,
    { baseUrl: url(), roomId: str() },
    { reporter },
  );
  if (baseUrl !== client.getHomeserverUrl())
    throw new Error("LOCAL_CONFIG_INVALID");
  return roomId;
}
