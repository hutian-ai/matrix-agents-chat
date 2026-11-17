import { randomBytes } from "node:crypto";
import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineCommand, runMain } from "citty";
import { cleanEnv, port } from "envalid";
import lockfile from "proper-lockfile";
import { x } from "tinyexec";
import writeFileAtomic from "write-file-atomic";
import {
  createMatrixClient,
  ensureRoom,
  inviteMember,
  joinRoom,
  provisionIdentity,
} from "../src/index.js";
import { loadLocalClient, loadSessionFile } from "../src/local.js";

const root = resolve(import.meta.dirname, "..");
const local = resolve(root, ".local");
const image = "matrixdotorg/synapse:v1.164.2";
interface Stack {
  version: 1;
  docker: string;
  dockerArgs: string[];
  project: string;
  serverName: string;
  port: number;
  webPort: number;
  runAs: string;
  externalDatabase: boolean;
}
async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return false;
    throw error;
  }
}
const save = async (file: string, value: unknown) =>
  writeFileAtomic(resolve(local, file), JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
const read = async (file: string) =>
  JSON.parse(await readFile(resolve(local, file), "utf8"));

async function docker(stack: Stack, args: string[], stdin?: string) {
  const result = await x(stack.docker, [...stack.dockerArgs, ...args], {
    ...(stdin === undefined ? {} : { stdin }),
    nodeOptions: { cwd: root },
  });
  await appendFile(resolve(local, "stack.log"), result.stdout + result.stderr, {
    mode: 0o600,
  });
  if (result.exitCode !== 0) throw new Error("DOCKER_COMMAND_FAILED");
  return result.stdout;
}
function compose(stack: Stack, args: string[]) {
  return docker(stack, [
    "compose",
    "--project-name",
    stack.project,
    "--env-file",
    ".local/stack.env",
    "-f",
    "compose.yaml",
    "-f",
    stack.externalDatabase
      ? ".local/database-compose.json"
      : "compose.postgres.yaml",
    ...args,
  ]);
}

async function prepare(args: {
  docker: string;
  "docker-args": string;
  project: string;
  server: string;
  port: string;
  "web-port": string;
  database?: string | undefined;
}) {
  if (await exists(resolve(local, "stack.json")))
    return read("stack.json") as Promise<Stack>;
  if (
    (await exists(resolve(local, "matrix-session.json"))) ||
    (await exists(resolve(local, "synapse/homeserver.yaml")))
  ) {
    throw new Error("EXISTING_INSTALLATION");
  }
  const dockerArgs: unknown = JSON.parse(args["docker-args"]);
  if (
    !Array.isArray(dockerArgs) ||
    !dockerArgs.every((arg) => typeof arg === "string") ||
    !/^[a-z0-9][a-z0-9-]{0,49}$/u.test(args.project) ||
    !/^[a-z0-9][a-z0-9.-]*$/u.test(args.server)
  )
    throw new Error("INVALID_SETUP");
  const ports = cleanEnv(
    { port: args.port, webPort: args["web-port"] },
    { port: port(), webPort: port() },
    {
      reporter: ({ errors }) => {
        if (Object.keys(errors).length) throw new Error("INVALID_SETUP");
      },
    },
  );
  const stack: Stack = {
    version: 1,
    docker: args.docker,
    dockerArgs,
    project: args.project,
    serverName: args.server,
    port: ports.port,
    webPort: ports.webPort,
    runAs: `${process.getuid?.() ?? 991}:${process.getgid?.() ?? 991}`,
    externalDatabase: Boolean(args.database),
  };
  let database = {
    host: "postgres",
    port: 5432,
    user: "matrix_chat",
    password: randomBytes(32).toString("hex"),
    dbname: "matrix_chat",
  };
  if (args.database) {
    const supplied = JSON.parse(await readFile(resolve(args.database), "utf8"));
    if (
      !supplied ||
      typeof supplied.host !== "string" ||
      typeof supplied.user !== "string" ||
      typeof supplied.password !== "string" ||
      typeof supplied.dbname !== "string" ||
      !Number.isInteger(supplied.port) ||
      typeof supplied.network !== "string" ||
      !supplied.network
    )
      throw new Error("INVALID_DATABASE");
    database = {
      host: supplied.host,
      port: supplied.port,
      user: supplied.user,
      password: supplied.password,
      dbname: supplied.dbname,
    };
    await save("database-compose.json", {
      networks: { default: { external: true, name: supplied.network } },
    });
  }
  await mkdir(resolve(local, "synapse"), { mode: 0o700, recursive: true });
  // Keep persisted infrastructure identifiers stable across the product rename.
  const registration = {
    id: "matrix-team-chat",
    url: null,
    as_token: randomBytes(32).toString("hex"),
    hs_token: randomBytes(32).toString("hex"),
    sender_localpart: "_mtc_service",
    rate_limited: true,
    namespaces: {
      users: [
        {
          exclusive: true,
          regex: `^@_mtc_[a-z0-9_-]+:${stack.serverName.replaceAll(".", "\\.")}\u0024`,
        },
      ],
      aliases: [],
      rooms: [],
    },
  };
  await save("synapse/appservice.yaml", registration);
  await save("application-service.json", {
    baseUrl: `http://127.0.0.1:${stack.port}`,
    accessToken: registration.as_token,
  });
  await save("synapse/bootstrap.json", { database, port: stack.port });
  await writeFileAtomic(
    resolve(local, "stack.env"),
    `MATRIX_PORT=${stack.port}\nSYNAPSE_RUN_AS=${stack.runAs}\nPOSTGRES_PASSWORD=${randomBytes(32).toString("hex")}\nPOSTGRES_APP_PASSWORD=${database.password}\n`,
    { mode: 0o600 },
  );
  await writeFileAtomic(
    resolve(local, "web.env"),
    `WEB_PORT=${stack.webPort}\n`,
    { mode: 0o600 },
  );
  await save("stack.json", stack);
  return stack;
}

async function setup(stack: Stack) {
  console.log("正在准备 Synapse 与 PostgreSQL。");
  await docker(stack, ["version", "--format", "{{.Server.Version}}"]);
  if (!(await exists(resolve(local, "synapse/homeserver.yaml")))) {
    await docker(stack, [
      "run",
      "--rm",
      "-v",
      `${resolve(local, "synapse")}:/data`,
      "-e",
      `SYNAPSE_SERVER_NAME=${stack.serverName}`,
      "-e",
      "SYNAPSE_REPORT_STATS=no",
      "-e",
      `UID=${stack.runAs.split(":")[0]}`,
      "-e",
      `GID=${stack.runAs.split(":")[1]}`,
      image,
      "generate",
    ]);
  }
  // 使用 Synapse 自带的 YAML 解析器修改官方生成配置，配置值不出现在命令行参数中。
  await docker(stack, [
    "run",
    "--rm",
    "--user",
    stack.runAs,
    "--entrypoint",
    "python",
    "-v",
    `${resolve(local, "synapse")}:/data`,
    image,
    "-c",
    `
import json,os,yaml
from pathlib import Path
path=Path('/data/homeserver.yaml')
config=yaml.safe_load(path.read_text())
settings=json.loads(Path('/data/bootstrap.json').read_text())
config.update(database={'name':'psycopg2','args':dict(settings['database'],cp_min=1,cp_max=5,sslmode='disable')},
 report_stats=False,enable_registration=False,federation_domain_whitelist=[],
 public_baseurl='http://127.0.0.1:'+str(settings['port'])+'/',
 app_service_config_files=['/data/appservice.yaml'],
 listeners=[{'port':8008,'type':'http','tls':False,'x_forwarded':False,'bind_addresses':['0.0.0.0'],
 'resources':[{'names':['client'],'compress':False}]}])
path.write_text(json.dumps(config,indent=2)+'\\n')
os.chmod(path,0o600)
`,
  ]);
  await compose(stack, ["up", "-d", "--wait", "--wait-timeout", "180"]);
  console.log("正在创建应用受管身份，无需逐个设置密码。");
  const serviceConfig = await read("application-service.json");
  const service = createMatrixClient(serviceConfig);
  const profiles = [
    {
      id: "owner",
      localpart: "_mtc_owner",
      name: "你",
      file: "matrix-session.json",
    },
    {
      id: "assistant",
      localpart: "_mtc_assistant",
      name: "协作助手",
      file: "matrix-peer-session.json",
    },
    {
      id: "reviewer",
      localpart: "_mtc_reviewer",
      name: "评审助手",
      file: "matrix-reviewer-session.json",
    },
  ];
  for (const profile of profiles) {
    if (!(await exists(resolve(local, profile.file)))) {
      const session = await provisionIdentity(service, {
        localpart: profile.localpart,
        deviceId: `MTC_${profile.id.toUpperCase()}`,
      });
      await save(profile.file, session);
      await createMatrixClient(session).setDisplayName(profile.name);
    }
    const client = await loadSessionFile(resolve(local, profile.file));
    if (client.getSafeUserId() !== `@${profile.localpart}:${stack.serverName}`)
      throw new Error("IDENTITY_MISMATCH");
  }
  if (!(await exists(resolve(local, "agents.json"))))
    await save(
      "agents.json",
      profiles.slice(1).map((profile) => ({
        id: profile.id,
        name: profile.name,
        description: "通过外部应用接入；配置执行宿主后可在网页触发",
        sessionFile: `.local/${profile.file}`,
      })),
    );
  const human = await loadLocalClient();
  const room = await ensureRoom(human, {
    aliasLocalpart: "team-chat",
    name: "Matrix Agents Chat",
  });
  for (const profile of profiles.slice(1)) {
    const client = await loadSessionFile(resolve(local, profile.file));
    await inviteMember(human, room.roomId, client.getSafeUserId());
    await joinRoom(client, room.roomId);
  }
  await save("matrix-room.json", {
    baseUrl: serviceConfig.baseUrl,
    roomId: room.roomId,
    roomAlias: room.roomAlias,
  });
  await writeFileAtomic(
    resolve(local, "room.env"),
    'MATRIX_ROOM_ALIAS=team-chat\nMATRIX_ROOM_NAME="Matrix Agents Chat"\n',
    { mode: 0o600 },
  );
  console.log(
    `聊天环境已就绪。运行 pnpm web，打开 http://127.0.0.1:${stack.webPort}。`,
  );
  console.log(
    "助手身份已准备好；真实模型回复需接入你自己的 SDK 宿主或 Harness Dock。",
  );
}

const main = defineCommand({
  meta: {
    name: "local-stack",
    description: "独立准备与管理 Matrix Agents Chat 的本机服务",
  },
  args: {
    action: {
      type: "positional",
      required: true,
      description: "setup | up | stop | status | doctor",
    },
    docker: {
      type: "string",
      default: "docker",
      description: "Docker 命令或本机包装器",
    },
    "docker-args": {
      type: "string",
      default: "[]",
      description: "包装器前置参数 JSON 数组",
    },
    project: {
      type: "string",
      default: "matrix-team-chat",
      description: "独立 Compose 项目名",
    },
    server: {
      type: "string",
      default: "matrix-team-chat.localhost",
      description: "首次安装的 Matrix 服务名称，之后不应更改",
    },
    port: {
      type: "string",
      default: "8008",
      description: "首次安装的本机 Matrix 端口",
    },
    "web-port": {
      type: "string",
      default: "3310",
      description: "首次安装的本机网页端口",
    },
    database: {
      type: "string",
      description: "可选：已准备的外部 PostgreSQL 私有 JSON 配置",
    },
  },
  async run({ args }) {
    try {
      if (!["setup", "up", "stop", "status", "doctor"].includes(args.action))
        throw new Error("UNKNOWN_ACTION");
      await mkdir(local, { recursive: true, mode: 0o700 });
      const release = await lockfile.lock(local);
      try {
        const stack: Stack =
          args.action === "setup"
            ? await prepare(args)
            : await read("stack.json");
        if (stack.version !== 1) throw new Error("INVALID_SETUP");
        if (args.action === "setup") await setup(stack);
        else if (args.action === "up") {
          await compose(stack, ["up", "-d", "--wait"]);
          console.log("本机服务已启动，数据保留。");
        } else if (args.action === "stop") {
          await compose(stack, ["stop"]);
          console.log("本机服务已停止，数据保留。");
        } else if (args.action === "status")
          console.log(await compose(stack, ["ps"]));
        else if (args.action === "doctor") {
          await docker(stack, ["version", "--format", "{{.Server.Version}}"]);
          await loadLocalClient();
          for (const file of [
            "matrix-peer-session.json",
            "matrix-reviewer-session.json",
          ])
            await loadSessionFile(resolve(local, file));
          console.log("Docker、Synapse 与三个聊天身份已确认；未调用模型。");
        } else throw new Error("UNKNOWN_ACTION");
      } finally {
        await release();
      }
    } catch (error) {
      await appendFile(resolve(local, "stack.log"), `${String(error)}\n`, {
        mode: 0o600,
      }).catch(() => {});
      const code = error instanceof Error ? error.message : "";
      console.error(
        code === "EXISTING_INSTALLATION"
          ? "已检测到既有手工环境，未覆盖配置或数据。请继续使用原服务入口；独立安装请使用新目录。"
          : "操作未完成，已有数据与凭据保留。请检查 Docker、私有配置与 .local/stack.log，沿同一命令继续。",
      );
      process.exitCode = 1;
    }
  },
});

await runMain(main);
