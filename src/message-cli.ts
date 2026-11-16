import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { defineCommand, runMain } from 'citty';
import { MatrixError } from 'matrix-js-sdk';
import { loadLocalClient, loadLocalRoom } from './local.js';
import { readHistory, sendMessage } from './message.js';

const commonArgs = {
  peer: { type: 'boolean', default: false, description: '使用第二个本地账号' },
  profile: { type: 'string', description: '使用指定名称的独立会话，如 reviewer' },
  room: { type: 'string', description: '房间 ID；默认读取 .local/matrix-room.json' },
} as const;
const sendArgs = {
  ...commonArgs,
  text: { type: 'string', required: true, description: '消息正文' },
  txn: { type: 'string', description: '事务 ID；重试同一条消息时沿用' },
} as const;

async function execute(action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    const code = error instanceof MatrixError ? error.errcode
      : error instanceof Error ? error.message : '';
    const reasons: Record<string, string> = {
      LOCAL_CONFIG_INVALID: '本地会话或房间配置无效，请重新登录或运行 pnpm matrix:room。',
      LOCAL_PROFILE_INVALID: '请使用有效的配置名称，--profile 和 --peer 分别使用。',
      CHAT_EMPTY_MESSAGE: '消息正文不能为空。',
      CHAT_EMPTY_TRANSACTION: '事务 ID 不能为空。',
      CHAT_INVALID_REPLY: '回复目标必须是当前账号在该房间内可读取的明文文本消息。',
      CHAT_INVALID_LIMIT: '每页数量必须是 1 到 100 的整数。',
      CHAT_ENCRYPTED_ROOM: '当前仅支持明文房间，不能操作已配置加密的房间。',
      CHAT_SYNC_INVALID_TIMEOUT: '同步等待时间必须是 0 到 30000 毫秒的整数。',
      CHAT_SYNC_INVALID_CURSOR: '同步游标不能为空。',
      CHAT_SYNC_INVALID_RESPONSE: '同步响应不完整，已保留原同步位置。',
      CHAT_SYNC_NOT_JOINED: '当前账号尚未加入房间或已经离开，同步位置未推进。',
      CHAT_SYNC_GAP: '无法完整补齐消息区间，已保留原同步位置。',
      CHAT_SYNC_STATE_INVALID: '本地同步记录损坏或不匹配，已停止，未自动重置。',
      CHAT_SYNC_LOCK_LOST: '同步进程失去文件锁，已停止。',
      ELOCKED: '该账号与房间已有同步进程，请先停止原进程。',
      M_UNKNOWN_TOKEN: '会话已失效，请重新登录对应账号。',
      M_FORBIDDEN: '当前账号没有权限，请检查房间成员关系与权限。',
      M_NOT_FOUND: '房间或消息不存在，或当前账号无法读取。',
      M_LIMIT_EXCEEDED: '服务暂时限流，请稍后使用原事务 ID 重试发送。',
    };
    const fileCode = error && typeof error === 'object' && 'code' in error
      && typeof error.code === 'string' ? error.code : '';
    console.error(reasons[fileCode] ?? reasons[code ?? '']
      ?? '通信操作失败，请检查 Synapse 服务和配置。同步请求失败时位置保留；重试发送沿用原事务 ID。');
    process.exitCode = 1;
  }
}

async function send(args: {
  peer: boolean;
  profile?: string | undefined;
  room?: string | undefined;
  text: string;
  txn?: string | undefined;
  event?: string | undefined;
}) {
  const client = await loadLocalClient(args.peer, args.profile);
  const roomId = args.room ?? await loadLocalRoom(client);
  const transactionId = args.txn ?? randomUUID();
  console.log(`事务 ID：${transactionId}`);
  const result = await sendMessage(client, {
    roomId, text: args.text, transactionId,
    ...(args.event === undefined ? {} : { replyTo: args.event }),
  });
  console.log(JSON.stringify({ eventId: result.event_id, roomId,
    senderId: client.getSafeUserId(), transactionId }, null, 2));
}

function terminalText(value: string) {
  return stripVTControlCharacters(value).replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '');
}

function printHistory(result: Awaited<ReturnType<typeof readHistory>>) {
  const time = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  console.log(`本页 ${result.events.length} 条消息（从早到晚，${time.resolvedOptions().timeZone}）`);
  for (const event of [...result.events].reverse()) {
    const date = new Date(event.origin_server_ts);
    const timestamp = Number.isFinite(date.getTime()) ? time.format(date) : '时间未知';
    console.log(`\n[${timestamp}] ${terminalText(event.sender)}`);
    const body = typeof event.content.body === 'string' ? event.content.body : '（没有可显示的文本）';
    console.log(terminalText(body).split('\n').map(line => `  ${line}`).join('\n'));
    console.log(`  消息 ID：${terminalText(event.event_id)}`);
    const replyTo = event.content['m.relates_to']?.['m.in_reply_to']?.event_id;
    if (typeof replyTo === 'string') console.log(`  回复消息：${terminalText(replyTo)}`);
  }
  if (result.nextCursor !== null) console.log(`\n更早消息游标（使用 --from 继续）：${terminalText(result.nextCursor)}`);
}

const main = defineCommand({
  meta: { name: 'matrix-agents-chat', description: '发送、回复、历史与增量同步' },
  subCommands: {
    sync: defineCommand({
      meta: { name: 'sync', description: '保存同步位置，重连后补收消息' },
      args: {
        ...commonArgs,
        once: { type: 'boolean', default: false, description: '只读取一批后退出' },
        limit: { type: 'string', default: '100', description: '同步与补收的每页数量，1 到 100' },
      },
      run: ({ args }) => execute(async () => {
        const { syncLocalRoom } = await import('./local-sync.js');
        await syncLocalRoom({ peer: args.peer, profile: args.profile, room: args.room,
          once: args.once, limit: Number(args.limit) });
      }),
    }),
    send: defineCommand({
      meta: { name: 'send', description: '发送文本消息' }, args: sendArgs,
      run: ({ args }) => execute(() => send(args)),
    }),
    reply: defineCommand({
      meta: { name: 'reply', description: '回复同一房间内的文本消息' },
      args: { ...sendArgs, event: { type: 'string', required: true, description: '被回复的消息 ID' } },
      run: ({ args }) => execute(() => send(args)),
    }),
    history: defineCommand({
      meta: { name: 'history', description: '读取历史，默认将本页消息从早到晚显示' },
      args: {
        ...commonArgs,
        limit: { type: 'string', default: '20', description: '每页数量，1 到 100' },
        from: { type: 'string', description: '上一页返回的 nextCursor' },
        json: { type: 'boolean', default: false, description: '输出原始 JSON，事件保持从新到旧排列' },
      },
      run: ({ args }) => execute(async () => {
        const client = await loadLocalClient(args.peer, args.profile);
        const result = await readHistory(client, {
          roomId: args.room ?? await loadLocalRoom(client), limit: Number(args.limit),
          ...(args.from === undefined ? {} : { from: args.from }),
        });
        if (args.json) console.log(JSON.stringify(result, null, 2));
        else printHistory(result);
      }),
    }),
  },
});

await runMain(main);
