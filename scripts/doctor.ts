import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadDotenv } from 'c12';
import { cleanEnv, str } from 'envalid';
import { loadAgentProfiles } from '../examples/agents.js';
import { loadLocalClient, loadLocalRoom } from '../src/local.js';
import { assertPlaintextRoom } from '../src/room.js';

try {
  const root = resolve(import.meta.dirname, '..');
  const human = await loadLocalClient();
  const agents = await loadAgentProfiles();
  const roomId = await loadLocalRoom(human);
  await assertPlaintextRoom(human, roomId);
  const joined = await human.getJoinedRooms();
  if (!joined.joined_rooms.includes(roomId)) throw new Error('DEFAULT_ROOM_NOT_JOINED');
  let executable = 0;
  for (const agent of agents) {
    if (agent.client.getHomeserverUrl() !== human.getHomeserverUrl() || agent.client.getSafeUserId() === human.getSafeUserId()) {
      throw new Error('INVALID_AGENT_IDENTITY');
    }
    if (!agent.hostConfigFile) continue;
    const raw = await loadDotenv({ cwd: root, fileName: agent.hostConfigFile, env: {}, interpolate: false });
    const config = cleanEnv(raw, { DOCK_CLIENT_COMMAND: str(), DOCK_CLIENT_CONFIG: str(),
      DOCK_CLIENT_ARGS_JSON: str({ default: '[]' }), HOST_ALLOWED_SENDER: str() },
    { reporter: ({ errors }) => { if (Object.keys(errors).length) throw new Error('INVALID_HOST_CONFIG'); } });
    const prefix: unknown = JSON.parse(config.DOCK_CLIENT_ARGS_JSON);
    if (!Array.isArray(prefix) || !prefix.every(value => typeof value === 'string') || config.HOST_ALLOWED_SENDER !== human.getSafeUserId()) {
      throw new Error('INVALID_HOST_CONFIG');
    }
    await access(resolve(root, config.DOCK_CLIENT_CONFIG));
    if (config.DOCK_CLIENT_COMMAND.includes('/')) await access(config.DOCK_CLIENT_COMMAND);
    executable++;
  }
  console.log(`聊天连接正常：1 位使用者、${agents.length} 位助手，默认房间可访问。`);
  console.log(`Dock 宿主配置已准备：${executable} 位；其余助手通过外部应用接入。`);
  console.log('未调用模型，也未占用 Dock 应用连接；真实执行结果以实际任务为准。');
} catch {
  console.error('诊断未通过，请检查 Synapse、私有会话、房间与助手宿主配置；未调用模型。');
  process.exitCode = 1;
}
