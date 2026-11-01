import type Dockerode from "dockerode";

/** Docker's existing authenticated transport, with deadlines on every control request. */
export function swarmRequest<T>(
  docker: Dockerode,
  method: string,
  path: string,
  input?: {
    body?: object;
    query?: Record<string, unknown>;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    stream?: boolean;
  },
): Promise<T> {
  const signal = input?.stream
    ? input.signal
    : AbortSignal.any([AbortSignal.timeout(30_000), ...(input?.signal ? [input.signal] : [])]);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    docker.modem.dial(
      {
        path: input?.query ? `${path}?` : path,
        method,
        options: method === "GET" || method === "DELETE" ? input?.query : input?.body,
        ...(method === "POST" && input?.query
          ? { options: { _query: input.query, _body: input.body } }
          : {}),
        headers: input?.headers,
        abortSignal: signal,
        isStream: input?.stream ?? false,
        statusCodes: {
          200: true,
          201: true,
          204: true,
          400: "Bad request",
          401: "Unauthorized",
          403: "Forbidden",
          404: "Not found",
          409: "Conflict",
          500: "Docker unavailable",
          503: "Swarm unavailable",
        },
      },
      (error, value) => (error ? reject(error) : resolve(value as T)),
    );
  });
}

export const swarmNotFound = (error: unknown) =>
  (error as { statusCode?: number })?.statusCode === 404;

export function swarmDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export interface SwarmTask {
  ID: string;
  NodeID?: string;
  Slot?: number;
  ServiceID: string;
  Spec?: { ForceUpdate?: number };
  DesiredState: string;
  Status: {
    State: string;
    Err?: string;
    Timestamp?: string;
    ContainerStatus?: { ContainerID?: string; ExitCode?: number };
  };
}
