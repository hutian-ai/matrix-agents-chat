export { createMatrixClient } from "./matrix-client.js";
export { provisionIdentity, type MatrixSession } from "./identity.js";
export {
  ensureRoom,
  inviteMember,
  joinRoom,
  isRoomArchived,
  setRoomArchived,
} from "./room.js";
export { sendMessage, readHistory } from "./message.js";
export { syncRoom, type SyncBatch } from "./sync.js";
export type { MatrixClient, ICreateClientOpts } from "matrix-js-sdk";
