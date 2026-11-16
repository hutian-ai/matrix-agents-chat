import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ConnectionError, HTTPError, safeGetRetryAfterMs } from 'matrix-js-sdk';
import lockfile from 'proper-lockfile';
import writeFileAtomic from 'write-file-atomic';
import { loadLocalClient, loadLocalRoom } from './local.js';
import { syncRoom } from './sync.js';

export async function syncLocalRoom(options: {
  peer: boolean;
  profile?: string | undefined;
  room?: string | undefined;
  once: boolean;
  limit: number;
}) {
  const client = await loadLocalClient(options.peer, options.profile);
  const roomId = options.room ?? await loadLocalRoom(client);
  const identity = { baseUrl: client.getHomeserverUrl(), userId: client.getSafeUserId(),
    deviceId: client.getDeviceId(), roomId };
  const scope = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const directory = `${import.meta.dirname}/../.local/sync`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const fileName = `${directory}/${scope}.json`;
  const controller = new AbortController();
  let compromised = false;
  const release = await lockfile.lock(fileName, {
    realpath: false,
    onCompromised: () => { compromised = true; controller.abort(); },
  });
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    let since: string | undefined;
    try {
      const raw = await readFile(fileName, 'utf8');
      const saved = JSON.parse(raw);
      if (saved.version !== 1 || saved.scope !== scope
        || typeof saved.nextCursor !== 'string' || !saved.nextCursor) {
        throw new Error('CHAT_SYNC_STATE_INVALID');
      }
      since = saved.nextCursor;
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw new Error('CHAT_SYNC_STATE_INVALID');
      }
    }
    let failures = 0;
    do {
      let batch;
      try {
        batch = await syncRoom(client, {
          roomId, limit: options.limit, timeoutMs: options.once ? 0 : 25_000,
          signal: controller.signal, ...(since === undefined ? {} : { since }),
        });
      } catch (error) {
        const retryable = error instanceof ConnectionError
          || error instanceof Error && error.name === 'AbortError'
          || error instanceof HTTPError
            && (error.isRateLimitError() || (error.httpStatus ?? 0) >= 500);
        if (controller.signal.aborted || options.once || !retryable) throw error;
        if (failures === 0) console.error('连接中断，同步位置保留，正在重试。');
        const waitMs = safeGetRetryAfterMs(error, Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)));
        await delay(Math.max(1000, waitMs), undefined, { signal: controller.signal });
        continue;
      }
      if (failures > 0) console.error('连接恢复，继续同步。');
      failures = 0;
      if (options.once || batch.initial || batch.events.length > 0) {
        await new Promise<void>((resolve, reject) => {
          // 输出成功后才推进文件中的位置；输出失败时允许下次重投。
          const onError = (error: Error) => reject(error);
          process.stdout.once('error', onError);
          process.stdout.write(JSON.stringify(batch) + '\n', error => {
            if (error) reject(error);
            else { process.stdout.off('error', onError); resolve(); }
          });
        });
      }
      if (compromised) throw new Error('CHAT_SYNC_LOCK_LOST');
      if (batch.nextCursor !== since) {
        await writeFileAtomic(fileName, JSON.stringify({ version: 1, scope, ...identity,
          nextCursor: batch.nextCursor }, null, 2) + '\n', { mode: 0o600 });
      }
      since = batch.nextCursor;
    } while (!options.once && !controller.signal.aborted);
  } catch (error) {
    if (compromised) throw new Error('CHAT_SYNC_LOCK_LOST');
    if (!controller.signal.aborted) throw error;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await release();
  }
}
