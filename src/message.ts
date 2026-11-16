import { Direction, EventType, Filter, MsgType, type MatrixClient } from 'matrix-js-sdk';
import { assertPlaintextRoom } from './room.js';

export async function sendMessage(client: MatrixClient, options: {
  roomId: string;
  text: string;
  transactionId: string;
  replyTo?: string;
  mentionedUserIds?: readonly string[];
  attachments?: readonly { id: string; name: string; mime: string; size: number; sha256: string; uri: string }[];
}) {
  const { roomId, text, transactionId, replyTo } = options;
  if (!text.trim()) throw new Error('CHAT_EMPTY_MESSAGE');
  if (!transactionId.trim()) throw new Error('CHAT_EMPTY_TRANSACTION');
  await assertPlaintextRoom(client, roomId);
  if (replyTo !== undefined) {
    if (!replyTo) throw new Error('CHAT_INVALID_REPLY');
    const target = await client.fetchRoomEvent(roomId, replyTo);
    if (target.event_id !== replyTo || target.type !== EventType.RoomMessage
      || target.content?.msgtype !== MsgType.Text || typeof target.content.body !== 'string') {
      throw new Error('CHAT_INVALID_REPLY');
    }
  }
  return client.sendMessage(roomId, {
    msgtype: MsgType.Text,
    body: text,
    ...(options.mentionedUserIds?.length ? { 'm.mentions': { user_ids: [...new Set(options.mentionedUserIds)] } } : {}),
    ...(options.attachments?.length ? { 'org.hutian.agents-chat.attachments': options.attachments } : {}),
    ...(replyTo === undefined ? {} : {
      'm.relates_to': { 'm.in_reply_to': { event_id: replyTo } },
    }),
  }, transactionId);
}

export async function readHistory(client: MatrixClient, options: {
  roomId: string;
  limit?: number;
  from?: string;
}) {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('CHAT_INVALID_LIMIT');
  }
  await assertPlaintextRoom(client, options.roomId);
  const filter = new Filter(client.getSafeUserId());
  filter.setDefinition({ room: { timeline: { types: [EventType.RoomMessage] } } });
  const page = await client.createMessagesRequest(
    options.roomId, options.from ?? null, limit, Direction.Backward, filter,
  );
  return { events: page.chunk, nextCursor: page.end ?? null };
}
