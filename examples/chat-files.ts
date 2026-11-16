import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { MatrixClient } from 'matrix-js-sdk';

const directory = resolve(import.meta.dirname, '../.local/chat-uploads');
export interface ChatFile { id: string; name: string; mime: string; size: number; sha256: string; uri: string }
export async function uploadChatFile(client: MatrixClient, value: { name: string; mime: string; contentBase64: string }): Promise<ChatFile> {
  if (!value.name || value.name.length > 180 || /[\/\\\r\n\0]/.test(value.name) || !value.mime || value.mime.length > 120 || value.contentBase64.length > 14 * 1024 * 1024) throw new Error('invalid_upload');
  const bytes = Buffer.from(value.contentBase64, 'base64');
  if (bytes.length > 8 * 1024 * 1024 || bytes.toString('base64') !== value.contentBase64) throw new Error('invalid_upload');
  const uploaded = await client.uploadContent(bytes, { name: value.name, type: value.mime });
  const result: ChatFile = { id: randomUUID(), name: value.name, mime: value.mime, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), uri: uploaded.content_uri };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(resolve(directory, `${result.id}.json`), JSON.stringify({ ...result, uploadedBy: client.getSafeUserId() }), { mode: 0o600, flag: 'wx' });
  return result;
}
export async function uploadedChatFile(client: MatrixClient, id: string): Promise<ChatFile> {
  if (!/^[\da-f-]{36}$/i.test(id)) throw new Error('invalid_upload');
  const file = JSON.parse(await readFile(resolve(directory, `${id}.json`), 'utf8'));
  if (file.uploadedBy !== client.getSafeUserId()) throw new Error('upload_owner_mismatch');
  const { uploadedBy: _, ...result } = file;
  return result;
}
export async function downloadChatFile(client: MatrixClient, file: ChatFile) {
  const uri = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(file.uri);
  if (!uri || file.size > 10 * 1024 * 1024) throw new Error('invalid_media_reference');
  const response = await fetch(`${client.getHomeserverUrl()}/_matrix/client/v1/media/download/${encodeURIComponent(uri[1]!)}/${encodeURIComponent(uri[2]!)}`, {
    headers: { Authorization: `Bearer ${client.getAccessToken()}` }, redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (!response.ok || Number(response.headers.get('content-length')) > 10 * 1024 * 1024) throw new Error('media_unavailable');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('media_changed');
  return bytes;
}
