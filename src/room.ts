import { EventType, MatrixError, Preset, Visibility, type MatrixClient } from 'matrix-js-sdk';

export async function assertPlaintextRoom(client: MatrixClient, roomId: string) {
  try {
    await client.getStateEvent(roomId, EventType.RoomEncryption, '');
  } catch (error) {
    if (error instanceof MatrixError && error.errcode === 'M_NOT_FOUND') return;
    throw error;
  }
  throw new Error('CHAT_ENCRYPTED_ROOM');
}

async function membership(client: MatrixClient, roomId: string, userId: string) {
  try {
    const event = await client.getStateEvent(roomId, EventType.RoomMember, userId);
    return typeof event.membership === 'string' ? event.membership : undefined;
  } catch (error) {
    if (!(error instanceof MatrixError) || error.errcode !== 'M_NOT_FOUND') throw error;
    return undefined;
  }
}

/** 按别名查找或创建邀请制房间；已有房间的名称和成员权限不会被覆盖。 */
export async function ensureRoom(
  owner: MatrixClient,
  options: { aliasLocalpart: string; name: string; kind?: 'direct' | 'group' | 'channel' },
) {
  const domain = owner.getDomain();
  if (!domain) throw new Error('ROOM_IDENTITY_REQUIRED');
  const roomAlias = `#${options.aliasLocalpart}:${domain}`;
  let roomId: string;
  let created = false;
  try {
    ({ room_id: roomId } = await owner.getRoomIdForAlias(roomAlias));
  } catch (error) {
    if (!(error instanceof MatrixError) || error.errcode !== 'M_NOT_FOUND') throw error;
    ({ room_id: roomId } = await owner.createRoom({
      room_alias_name: options.aliasLocalpart,
      name: options.name,
      visibility: Visibility.Private,
      preset: Preset.PrivateChat,
      creation_content: { 'm.federate': false, 'org.hutian.agents-chat.kind': options.kind ?? 'group' },
    }));
    created = true;
  }
  const joinRules = await owner.getStateEvent(roomId, EventType.RoomJoinRules, '');
  if (joinRules.join_rule !== 'invite') throw new Error('ROOM_MUST_REQUIRE_INVITATION');
  if (await membership(owner, roomId, owner.getSafeUserId()) !== 'join') {
    throw new Error('ROOM_OWNER_NOT_JOINED');
  }
  return { roomId, roomAlias, created };
}

/** 邀请指定成员；已加入时不重复邀请，也不代表对方接受邀请。 */
export async function inviteMember(owner: MatrixClient, roomId: string, userId: string) {
  const current = await membership(owner, roomId, userId);
  if (current === 'join' || current === 'invite') return current;
  await owner.invite(roomId, userId);
  if (await membership(owner, roomId, userId) !== 'invite') {
    throw new Error('ROOM_INVITATION_NOT_CONFIRMED');
  }
  return 'invite';
}

/** 使用被邀请者自己的已认证客户端加入房间。 */
export async function joinRoom(member: MatrixClient, roomId: string) {
  const userId = member.getSafeUserId();
  await member.joinRoom(roomId);
  const state = await membership(member, roomId, userId);
  if (state !== 'join') throw new Error('ROOM_JOIN_NOT_CONFIRMED');
  return { userId, membership: state };
}
