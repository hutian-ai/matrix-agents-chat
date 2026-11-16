# 本机部署

## 独立安装

在干净的仓库目录运行：

```sh
pnpm install --frozen-lockfile
pnpm local:setup
pnpm web
```

依赖 Node.js 22.16+、pnpm 11 和运行中的 Docker。安装器使用官方 Synapse 镜像生成配置；默认 Compose 同时启动 PostgreSQL，初始化独立的管理员与普通应用账号。Synapse 自己管理业务表，项目没有自建聊天表。

所有配置与身份会话在 `.local/`，目录权限为 `700`、私有文件为 `600`。数据库在 Docker 持久卷。AS 注册、签名密钥、用户会话和宿主回执都应保留；不要通过删除它们处理未知结果。

安装命令遇到失败时保留已生成状态，修复原因后沿同一命令继续。日志在 `.local/stack.log`，其中可能包含环境细节，勿直接公开。

更换首次安装端口：

```sh
pnpm local:setup --port 18008 --web-port 13310 --project my-chat
```

端口和 Matrix 服务名一旦写入配置，后续启动复用它们。`--server` 决定永久 Matrix 身份域，不能通过改一个名字迁移旧数据。

## 使用现有共享 PostgreSQL

先由管理员准备专用数据库与非管理员账号，数据库使用 `UTF8`、`C` locale、`template0`。将如下结构保存为本机私有 JSON，替换示例值：

```json
{
  "host": "your-postgres-container",
  "port": 5432,
  "user": "matrix_chat",
  "password": "replace-in-private-file",
  "dbname": "matrix_chat",
  "network": "your-existing-docker-network"
}
```

```sh
pnpm local:setup --database /absolute/path/to/private-database.json
```

此模式只启动 Synapse，不创建第二个 PostgreSQL。用于同机 Docker 网络，连接不启用 TLS。云数据库与远程生产部署需要接入方另行配置网络、证书和访问控制。

若 Docker 通过包装命令提供，可使用 `--docker /path/to/wrapper --docker-args '["docker"]'`。默认直接使用 PATH 中的 `docker`，源码不依赖相邻 hutian 仓库。

## 已有手工环境

`local:setup` 检测到既有会话或 Synapse 配置、却没有安装器元数据时，会明确拒绝覆盖。继续使用原服务入口，运行 `pnpm doctor` 和 `pnpm web` 即可。

本工作区原有环境使用 `compose.local.yaml` 和共享 PostgreSQL 包装器；`pnpm synapse:start`、`synapse:stop`、`synapse:status` 保留为该环境兼容入口。它们不属于新目录的独立安装流程，也不会自动迁移原数据。

## 日常操作

```sh
pnpm local:status
pnpm local:stop
pnpm local:up
pnpm doctor
pnpm web
```

网页默认只在 `127.0.0.1` 提供服务，检查 Host、Origin 与提交类型。请使用打印出的确切地址。不要直接将该端口代理到公网；它使用一位固定操作者的本机会话。

未配置 Dock 的助手仍能经 SDK 收发消息，网页执行入口保持禁用。配置真实模型执行见 [接入说明](integration.md#在新环境配置-dock-宿主)；诊断不会占用 Dock 应用连接或调用模型。

## 备份与恢复

独立安装的容器状态不等于数据备份。需要同时备份：PostgreSQL 数据、`.local/synapse/` 的配置 / 签名密钥 / 媒体、身份会话、助手配置与 `.local/agent-host/` 的原运行回执。备份包含凭据，应留在私有位置。

默认安装的 PostgreSQL 可使用 Docker Compose 的 `exec -T postgres pg_dump -U mtc_admin matrix_chat` 导出，Compose 参数沿用 `.local/stack.json` 对应的项目名及两个 Compose 文件；共享数据库使用其管理员已有备份方式。

恢复时先恢复同一服务名的数据库和私有配置，再启动服务；不要自动重新生成身份或回执。网页关闭只停止观察，不能据此判断设备上的执行已取消。恢复后查看同一消息的原运行；缺少回执则保留待核对，不重新派发。

官方依据：[Synapse Docker](https://hub.docker.com/r/matrixdotorg/synapse)、[PostgreSQL 配置](https://element-hq.github.io/synapse/latest/postgres.html)、[Application Service 注册](https://element-hq.github.io/synapse/latest/application_services.html)。
