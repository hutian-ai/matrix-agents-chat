import { loadDotenv } from "c12";
import { cleanEnv, str } from "envalid";
import writeFileAtomic from "write-file-atomic";
import { loadLocalClient } from "./local.js";
import { ensureRoom, inviteMember, joinRoom } from "./room.js";

let failure = "无法读取房间配置，请检查 .local/room.env。";

try {
  const raw = await loadDotenv({
    cwd: import.meta.dirname,
    fileName: "../.local/room.env",
    env: {},
    interpolate: false,
  });
  const config = cleanEnv(
    raw,
    {
      MATRIX_ROOM_ALIAS: str({ default: "team-chat" }),
      MATRIX_ROOM_NAME: str({ default: "Matrix Agents Chat" }),
    },
    {
      reporter: ({ errors }) => {
        if (Object.keys(errors).length > 0)
          throw new Error("INVALID_ROOM_CONFIG");
      },
    },
  );
  failure = "无法确认成员会话，请检查 Synapse 状态或重新运行对应的登录命令。";
  const owner = await loadLocalClient();
  const peer = await loadLocalClient(true);
  const ownerId = owner.getSafeUserId();
  const peerId = peer.getSafeUserId();
  failure = "需要同一服务上的两个不同身份，请检查两份会话配置。";
  if (
    ownerId === peerId ||
    owner.getHomeserverUrl() !== peer.getHomeserverUrl()
  ) {
    throw new Error("INVALID_PARTICIPANTS");
  }
  failure = "无法查找或创建邀请制房间，请检查成员会话和房间设置。";
  const room = await ensureRoom(owner, {
    aliasLocalpart: config.MATRIX_ROOM_ALIAS,
    name: config.MATRIX_ROOM_NAME,
  });
  failure = "无法邀请成员，请检查成员状态和房间邀请权限。";
  const invitation = await inviteMember(owner, room.roomId, peerId);
  if (invitation === "invite")
    console.log(`邀请已确认：${ownerId} → ${peerId}`);
  failure = "无法确认成员加入。可重新运行同一命令继续。";
  const peerMembership =
    invitation === "join"
      ? "join"
      : (await joinRoom(peer, room.roomId)).membership;
  failure = "成员均已加入，但无法保存本地房间引用。";
  await writeFileAtomic(
    `${import.meta.dirname}/../.local/matrix-room.json`,
    JSON.stringify(
      {
        baseUrl: owner.getHomeserverUrl(),
        roomId: room.roomId,
        roomAlias: room.roomAlias,
        ownerId,
        peerId,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  console.log("房间与成员已就绪。");
  console.log(
    `房间：${room.roomAlias}（${room.created ? "已创建" : "复用已有房间"}）`,
  );
  console.log(`房间 ID：${room.roomId}`);
  console.log(`成员 A：${ownerId} · join`);
  console.log(`成员 B：${peerId} · ${peerMembership}`);
} catch {
  console.error(failure);
  process.exitCode = 1;
}
