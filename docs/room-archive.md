# 房间归档

归档只影响当前 Matrix 用户的默认房间目录。成员身份、权限、消息、附件及原消息引用保持不变；直接读取原房间和历史仍可用。归档不停止或取消执行。

SDK 提供 `isRoomArchived(client, roomId)` 和 `setRoomArchived(client, roomId, archived)`。使用 Matrix 原生用户房间标签保存 `org.hutian.agents-chat.archived`；恢复时传入 `false`，只删除该标签，保留其他标签。

本机 HTTP 宿主默认从 `GET /api/rooms` 隐藏已归档房间。维护时使用 `GET /api/rooms?includeArchived=true` 查看包含 `archived` 标记的完整目录。`POST /api/rooms/archive` 接受 `{ roomId, archived }`，沿用本机来源校验和当前用户的房间成员校验。

没有新增前端归档管理页面。恢复可通过上述 SDK 或本机接口完成；不会退出房间、删除历史或改变定时安排。
