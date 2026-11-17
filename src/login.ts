import { loadDotenv } from "c12";
import { defineCommand, runMain } from "citty";
import { cleanEnv, str, url } from "envalid";
import writeFileAtomic from "write-file-atomic";
import { createMatrixClient } from "./matrix-client.js";

const main = defineCommand({
  meta: { name: "matrix-login", description: "登录并保存本机 Matrix 身份会话" },
  args: {
    peer: {
      type: "boolean",
      default: false,
      description: "使用原协作助手配置",
    },
    profile: {
      type: "string",
      description: "使用 .local/matrix-名称.env 中的独立身份",
    },
  },
  async run({ args }) {
    if (
      args.profile !== undefined &&
      (!/^[a-z][a-z0-9-]{0,49}$/u.test(args.profile) || args.peer)
    ) {
      console.error(
        "配置名称应由小写字母、数字与短横线组成，--profile 与 --peer 分别使用。",
      );
      process.exitCode = 1;
      return;
    }
    const profile =
      args.profile !== undefined
        ? `-${args.profile}`
        : args.peer
          ? "-peer"
          : "";
    const configFile = `.local/matrix${profile}.env`;
    let failure = `无法读取 ${configFile}。`;

    try {
      const raw = await loadDotenv({
        cwd: import.meta.dirname,
        fileName: `../${configFile}`,
        env: {},
        interpolate: false,
      });
      const config = cleanEnv(
        raw,
        {
          MATRIX_BASE_URL: url(),
          MATRIX_USER: str(),
          MATRIX_PASSWORD: str(),
          MATRIX_DEVICE_ID: str(),
        },
        {
          reporter: ({ errors }) => {
            const fields = Object.keys(errors);
            if (fields.length > 0) {
              failure = `配置缺失或格式错误：${fields.join("、")}。请检查 ${configFile}。`;
              throw new Error("INVALID_CONFIG");
            }
          },
        },
      );

      failure = "登录失败，请检查账号、密码以及 Synapse 服务状态。";
      const login = await createMatrixClient({
        baseUrl: config.MATRIX_BASE_URL,
      }).loginRequest({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: config.MATRIX_USER },
        password: config.MATRIX_PASSWORD,
        device_id: config.MATRIX_DEVICE_ID,
        initial_device_display_name: "Matrix Agents Chat CLI",
      });

      const session = {
        baseUrl: config.MATRIX_BASE_URL,
        userId: login.user_id,
        deviceId: login.device_id,
        accessToken: login.access_token,
      };
      failure = "登录后的身份确认失败。";
      const identity = await createMatrixClient(session).whoami();
      if (
        identity.user_id !== config.MATRIX_USER ||
        identity.user_id !== session.userId ||
        identity.device_id !== config.MATRIX_DEVICE_ID ||
        identity.device_id !== session.deviceId
      ) {
        throw new Error("IDENTITY_MISMATCH");
      }

      failure = "身份已确认，但无法保存私有会话文件。";
      await writeFileAtomic(
        `${import.meta.dirname}/../.local/matrix${profile}-session.json`,
        JSON.stringify(session, null, 2) + "\n",
        { mode: 0o600 },
      );
      console.log("Matrix 登录与身份确认成功。");
      console.log(`账号：${identity.user_id}`);
      console.log(`设备：${identity.device_id}`);
    } catch {
      console.error(failure);
      process.exitCode = 1;
    }
  },
});

await runMain(main);
