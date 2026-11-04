import { randomUUID } from "node:crypto";
import { Readable, type Duplex } from "node:stream";
import type Dockerode from "dockerode";
import {
  loadPackageDefinition,
  Server,
  ServerCredentials,
  type ServiceDefinition,
} from "@grpc/grpc-js";
import { fromJSON } from "@grpc/proto-loader";
import { daemonConnectionFrom, startBuildKitSessionStream } from "./docker-exec-stream";

// Standard BuildKit auth and gRPC health schemas, kept in the bundle so Desktop,
// npm CLI and source releases need no runtime .proto files or dependency patches.
const definitions = loadPackageDefinition(
  fromJSON(
    {
      nested: {
        grpc: {
          nested: {
            health: {
              nested: {
                v1: {
                  nested: {
                    HealthCheckRequest: { fields: { service: { type: "string", id: 1 } } },
                    HealthCheckResponse: { fields: { status: { type: "int32", id: 1 } } },
                    Health: {
                      methods: {
                        Check: {
                          comment: "",
                          requestType: "HealthCheckRequest",
                          responseType: "HealthCheckResponse",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        moby: {
          nested: {
            filesync: {
              nested: {
                v1: {
                  nested: {
                    CredentialsRequest: { fields: { Host: { type: "string", id: 1 } } },
                    CredentialsResponse: {
                      fields: {
                        Username: { type: "string", id: 1 },
                        Secret: { type: "string", id: 2 },
                      },
                    },
                    Auth: {
                      methods: {
                        Credentials: {
                          comment: "",
                          requestType: "CredentialsRequest",
                          responseType: "CredentialsResponse",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    { keepCase: true },
  ),
) as unknown as {
  grpc: { health: { v1: { Health: { service: ServiceDefinition } } } };
  moby: { filesync: { v1: { Auth: { service: ServiceDefinition } } } };
};

function serverService(service: ServiceDefinition): ServiceDefinition {
  // protobufjs may select Uint8Array output in a bundled runtime. grpc-js's
  // Node transport requires Buffer.copy(), so normalize at the RPC boundary.
  return Object.fromEntries(
    Object.entries(service).map(([name, method]) => [
      name,
      {
        ...method,
        responseSerialize: (value: unknown) => Buffer.from(method.responseSerialize(value)),
      },
    ]),
  );
}

/** Own the session for exactly as long as the build response is being consumed. */
export async function buildDockerImage(
  docker: Dockerode,
  context: NodeJS.ReadableStream,
  options: Dockerode.ImageBuildOptions,
): Promise<Readable> {
  if (options.version !== "2") return (await docker.buildImage(context, options)) as Readable;
  const signal = options.abortSignal;
  signal?.throwIfAborted();
  const server = new Server();
  let socket: Duplex | undefined;
  let response: Readable | undefined;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", onAbort);
    server.forceShutdown();
    socket?.destroy();
  };
  const onAbort = () => {
    response?.destroy();
    cleanup();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // BuildKit probes this every five seconds and disconnects after two failed
    // probes. dockerode's implicit session only implements Auth (#1488).
    server.addService(serverService(definitions.grpc.health.v1.Health.service), {
      Check: (_call: unknown, callback: (error: null, value: { status: number }) => void) =>
        callback(null, { status: 1 }), // SERVING
    });
    server.addService(serverService(definitions.moby.filesync.v1.Auth.service), {
      Credentials: (
        _call: unknown,
        callback: (error: null, value: { Username?: string; Secret?: string }) => void,
      ) =>
        callback(
          null,
          options.authconfig && "username" in options.authconfig
            ? {
                Username: options.authconfig.username,
                Secret: options.authconfig.password,
              }
            : {},
        ),
    });
    const session = randomUUID();
    socket = await startBuildKitSessionStream(daemonConnectionFrom(docker), session, "openship");
    if (closed) {
      socket.destroy();
      signal?.throwIfAborted();
      throw new Error("BuildKit session closed before the build started");
    }
    server.createConnectionInjector(ServerCredentials.createInsecure()).injectConnection(socket);
    const { authconfig, registryconfig, abortSignal: _signal, ...query } = options;
    // The context is already packed by the shared build pipeline. Using the
    // same modem preserves its transport/auth/cancellation while avoiding a
    // second, unhealthy session created by dockerode.buildImage(version: "2").
    response = await new Promise<Readable>((resolve, reject) => {
      docker.modem.dial(
        {
          path: "/build?",
          method: "POST",
          file: context,
          options: { ...query, session },
          authconfig,
          registryconfig,
          abortSignal: signal,
          isStream: true,
          statusCodes: { 200: true, 500: "server error" },
        },
        (error, stream) => {
          if (error) reject(error);
          else if (stream instanceof Readable) resolve(stream);
          else reject(new Error("Docker build did not return a response stream"));
        },
      );
    });
    response.once("end", cleanup);
    response.once("error", cleanup);
    response.once("close", cleanup);
    if (closed || signal?.aborted) {
      response.destroy();
      signal?.throwIfAborted();
      throw new Error("BuildKit session closed before the build response arrived");
    }
    return response;
  } catch (error) {
    cleanup();
    throw error;
  }
}
