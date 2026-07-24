import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { MysqlDumpProducer, mysqlCredentials } from "./mysql-dump";
import type { BackupExecutor, ExecExitInfo, ServiceHandle } from "../types";

function serviceWith(env: Record<string, string>): ServiceHandle {
  return {
    id: "svc-1",
    projectId: "proj-1",
    name: "db",
    image: "mysql:8.0",
    env,
    volumes: [],
    containerId: "c1",
    projectSlug: "app",
    namespaceVolumes: true,
  };
}

/** Records the argv of the first execStream/pipeIntoCommand call. */
function captureExecutor(): { executor: BackupExecutor; lastCmd: () => string[] } {
  let captured: string[] = [];
  const exit: ExecExitInfo = { code: 0, stderr: "" };
  const executor = {
    runtimeName: "docker",
    async execStream(_service: ServiceHandle, cmd: string[]) {
      captured = cmd;
      return { stdout: Readable.from([]), awaitExit: Promise.resolve(exit) };
    },
    async pipeIntoCommand(_service: ServiceHandle, cmd: string[]) {
      captured = cmd;
      return exit;
    },
  } as unknown as BackupExecutor;
  return { executor, lastCmd: () => captured };
}

describe("mysqlCredentials", () => {
  it("pairs root with MYSQL_ROOT_PASSWORD when a non-root MYSQL_USER is also set", () => {
    const creds = mysqlCredentials({
      MYSQL_ROOT_PASSWORD: "rootpw",
      MYSQL_DATABASE: "wordpress",
      MYSQL_USER: "wordpress",
      MYSQL_PASSWORD: "wppw",
    });
    expect(creds).toEqual({ user: "root", password: "rootpw" });
  });

  it("uses root with MYSQL_ROOT_PASSWORD when no MYSQL_USER is set", () => {
    expect(mysqlCredentials({ MYSQL_ROOT_PASSWORD: "rootpw" })).toEqual({
      user: "root",
      password: "rootpw",
    });
  });

  it("pairs MYSQL_USER with MYSQL_PASSWORD when no root password is present", () => {
    expect(mysqlCredentials({ MYSQL_USER: "app", MYSQL_PASSWORD: "apppw" })).toEqual({
      user: "app",
      password: "apppw",
    });
  });

  it("falls back to root with an empty password when nothing is set", () => {
    expect(mysqlCredentials({})).toEqual({ user: "root", password: "" });
  });
});

describe("MysqlDumpProducer command construction", () => {
  const env = {
    MYSQL_ROOT_PASSWORD: "rootpw",
    MYSQL_DATABASE: "wordpress",
    MYSQL_USER: "wordpress",
    MYSQL_PASSWORD: "wppw",
  };

  it("authenticates the dump as root using the root password", async () => {
    const { executor, lastCmd } = captureExecutor();
    // Drain the async generator so produce() issues the exec call.
    for await (const _artifact of MysqlDumpProducer.produce(serviceWith(env), executor, {})) {
      // no-op
    }
    const script = lastCmd()[2] ?? "";
    expect(script).toContain("MYSQL_PWD='rootpw'");
    expect(script).toContain("-u 'root'");
    expect(script).not.toContain("-u 'wordpress'");
  });

  it("restores as root using the root password", async () => {
    const { executor, lastCmd } = captureExecutor();
    await MysqlDumpProducer.restore(
      serviceWith(env),
      executor,
      {
        metadata: {},
        open: async () => Readable.from([]),
      } as never,
      {},
    );
    const script = lastCmd()[2] ?? "";
    expect(script).toContain("MYSQL_PWD='rootpw'");
    expect(script).toContain("-u 'root'");
    expect(script).not.toContain("-u 'wordpress'");
  });
});
