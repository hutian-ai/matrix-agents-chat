import { createClient, type ICreateClientOpts } from 'matrix-js-sdk';

// 不直接输出 SDK 内部日志，避免暴露请求或会话细节。
const quietLogger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
  getChild() { return quietLogger; },
};

export function createMatrixClient(options: ICreateClientOpts) {
  return createClient({ ...options, logger: quietLogger, localTimeoutMs: 10_000 });
}
