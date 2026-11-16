# 第 16 段：Matrix Agents Chat 更名

2026-11-13。用户将 Matrix Team Chat 更名为 **Matrix Agents Chat**。

网页品牌、标题、CLI 显示名、新安装房间的显示名和 SDK 包名已更新。包名为 `@hutian-ai/matrix-agents-chat`，公开导出与通信职责不变。

现有目录与私有 GitHub 仓库仍为 `matrix-team-chat`，没有更改远端。已有 homeserver 名称、Compose 项目、Application Service 标识与房间别名保留兼容，避免重新建立身份、数据卷或房间。已有房间名称是用户数据，不批量更名。以前的阶段记录保留历史名称。

验证：`pnpm check`、`pnpm web:build`、`pnpm build` 通过；真实浏览器读取现有房间、成员和历史，网页标题为 Matrix Agents Chat。无模型调用，无新增测试、框架或依赖。

本段保留未提交 diff。没有推送、公开开源、npm / Release 或 X 发布。旧源码快照保存在忽略提交的 `.local/rename-2026-11-13/`。

待发布文案：Matrix Agents Chat 是人与 Agent 的独立通信模块，提供 Matrix 房间、身份、消息、引用、历史与增量同步；调用方选择 Agent 宿主及执行方式。当前支持本机多房间、多助手和人工转交，尚未公开发布。
