import { MatrixError, Method, type MatrixClient } from "matrix-js-sdk";

export interface MatrixSession {
  baseUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
}

/** 可信宿主专用：使用已注册 Application Service 创建无密码身份并取得该身份自己的会话。 */
export async function provisionIdentity(
  service: MatrixClient,
  options: {
    localpart: string;
    deviceId: string;
  },
): Promise<MatrixSession> {
  if (!/^_[a-z0-9._=-]+$/u.test(options.localpart) || !options.deviceId.trim())
    throw new Error("CHAT_INVALID_IDENTITY");
  try {
    // registerRequest 不附带授权头；应用服务注册必须使用带 AS token 的原生请求。
    await service.http.authedRequest(Method.Post, "/register", undefined, {
      type: "m.login.application_service",
      username: options.localpart,
      inhibit_login: true,
    });
  } catch (error) {
    if (!(error instanceof MatrixError) || error.errcode !== "M_USER_IN_USE")
      throw error;
  }
  const session = await service.loginRequest({
    type: "m.login.application_service",
    identifier: { type: "m.id.user", user: options.localpart },
    device_id: options.deviceId,
    initial_device_display_name: "Matrix Agents Chat host",
  });
  if (
    !session.user_id.startsWith(`@${options.localpart}:`) ||
    session.device_id !== options.deviceId ||
    !session.access_token
  ) {
    throw new Error("CHAT_IDENTITY_MISMATCH");
  }
  return {
    baseUrl: service.getHomeserverUrl(),
    userId: session.user_id,
    deviceId: session.device_id,
    accessToken: session.access_token,
  };
}
