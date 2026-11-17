/** Protocol for the optional local execution host, separate from the Matrix SDK. */
export const HOST_PROTOCOL_VERSION = "1";
export class HostClientError extends Error {
  readonly status: number;
  readonly kind: "transport" | "protocol" | "http";
  constructor(kind: HostClientError["kind"], status: number) {
    super(`Local host ${kind} failure`);
    this.kind = kind;
    this.status = status;
  }
}
export interface HostRequestIdentity {
  roomId: string;
  eventId: string;
  agentId: string;
}
/** Never logs or propagates an upstream error body. Consumers validate operation-specific DTOs. */
export class LocalHostClient {
  readonly origin: string;
  constructor(url: string) {
    const origin = new URL(url);
    if (
      origin.protocol !== "http:" ||
      origin.hostname !== "127.0.0.1" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new HostClientError("protocol", 502);
    this.origin = origin.origin;
  }
  async request(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!path.startsWith("/api/") || path.includes("\\"))
      throw new HostClientError("protocol", 502);
    let response: Response;
    try {
      response = await fetch(this.origin + path, {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(35000),
          ...(signal ? [signal] : []),
        ]),
        ...(body === undefined
          ? {}
          : {
              method: "POST",
              headers: {
                "content-type": "application/json",
                origin: this.origin,
              },
              body: JSON.stringify(body),
            }),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new HostClientError("transport", 503);
    }
    if (!response.ok) throw new HostClientError("http", response.status);
    if (
      response.headers.get("x-matrix-agents-host-protocol") !==
      HOST_PROTOCOL_VERSION
    )
      throw new HostClientError("protocol", 502);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new HostClientError("protocol", 502);
    }
  }
  observe(identity: HostRequestIdentity, signal?: AbortSignal) {
    return this.request(
      `/api/agent/status?${new URLSearchParams({ ...identity })}`,
      undefined,
      signal,
    );
  }
}
