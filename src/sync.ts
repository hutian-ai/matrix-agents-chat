import {
  EventType,
  Method,
  type IRoomEvent,
  type ISyncResponse,
  type MatrixClient,
} from "matrix-js-sdk";
import { assertPlaintextRoom } from "./room.js";

export interface SyncBatch {
  roomId: string;
  events: IRoomEvent[];
  nextCursor: string;
  initial: boolean;
  backfilled: boolean;
}

/** 读取一批；调用方处理成功后才保存 nextCursor。首次调用返回最近消息快照。 */
export async function syncRoom(
  client: MatrixClient,
  options: {
    roomId: string;
    since?: string | undefined;
    limit?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<SyncBatch> {
  const { roomId, since, signal } = options;
  const limit = options.limit ?? 100;
  const timeoutMs = options.timeoutMs ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("CHAT_INVALID_LIMIT");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) {
    throw new Error("CHAT_SYNC_INVALID_TIMEOUT");
  }
  if (since !== undefined && !since)
    throw new Error("CHAT_SYNC_INVALID_CURSOR");
  signal?.throwIfAborted();
  await assertPlaintextRoom(client, roomId);
  const member = await client.getStateEvent(
    roomId,
    EventType.RoomMember,
    client.getSafeUserId(),
  );
  if (member.membership !== "join") throw new Error("CHAT_SYNC_NOT_JOINED");
  const requestOptions = {
    localTimeoutMs: timeoutMs + 10_000,
    ...(signal === undefined ? {} : { abortSignal: signal }),
  };
  const response = await client.http.authedRequest<ISyncResponse>(
    Method.Get,
    "/sync",
    {
      timeout: timeoutMs,
      set_presence: "offline",
      ...(since === undefined ? {} : { since }),
      filter: JSON.stringify({
        room: {
          rooms: [roomId],
          timeline: { types: [EventType.RoomMessage], limit },
          state: { types: [] },
          ephemeral: { types: [] },
          account_data: { types: [] },
        },
        presence: { types: [] },
        account_data: { types: [] },
        to_device: { types: [] },
      }),
    },
    undefined,
    requestOptions,
  );
  if (typeof response.next_batch !== "string" || !response.next_batch) {
    throw new Error("CHAT_SYNC_INVALID_RESPONSE");
  }
  if (response.rooms?.leave?.[roomId]) throw new Error("CHAT_SYNC_NOT_JOINED");
  const timeline = response.rooms?.join?.[roomId]?.timeline;
  const backfilled = since !== undefined && timeline?.limited === true;
  const events: IRoomEvent[] = [];
  if (backfilled) {
    // /sync 的截断段不能直接确认；用原生 /messages 的边界补齐同一区间。
    let from = since;
    const visited = new Set([from]);
    while (true) {
      const page = await client.http.authedRequest<{
        chunk: IRoomEvent[];
        end?: string;
      }>(
        Method.Get,
        `/rooms/${encodeURIComponent(roomId)}/messages`,
        {
          from,
          to: response.next_batch,
          dir: "f",
          limit,
          filter: JSON.stringify({ types: [EventType.RoomMessage] }),
        },
        undefined,
        requestOptions,
      );
      events.push(...page.chunk);
      if (!page.end || page.end === response.next_batch) break;
      if (visited.has(page.end)) throw new Error("CHAT_SYNC_GAP");
      visited.add(page.end);
      from = page.end;
    }
  }
  // 原生区间边界可能不含最后一个事件，合并 /sync 尾部并按事件 ID 去重。
  const seen = new Set(events.map((event) => event.event_id));
  for (const event of timeline?.events ?? []) {
    if (!seen.has(event.event_id)) {
      events.push(event);
      seen.add(event.event_id);
    }
  }
  return {
    roomId,
    events,
    nextCursor: response.next_batch,
    initial: since === undefined,
    backfilled,
  };
}
