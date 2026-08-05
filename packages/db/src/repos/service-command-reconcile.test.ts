import { describe, expect, it } from "vitest";
import { commandToArgv } from "@repo/core";
import type { Database } from "../client";
import { createServiceRepo, toComposeSpec } from "./service.repo";

const script = `if [ "\${RUN_APP:-false}" != "true" ]; then
  echo "disabled"
  exec sleep 2147483647
fi
exec bin/app start`;
const structuredArgv = ["/bin/sh", "-ec", script];
const displayCommand = structuredArgv.join(" ");
const flattenedArgv = commandToArgv(displayCommand)!;

function fakeRepoRow(opts: { baseline: "none" | "structured"; argv?: string[] }) {
  const row = {
    id: "svc_1",
    projectId: "proj_1",
    name: "app",
    kind: "compose",
    command: displayCommand,
    commandArgv: opts.argv ?? flattenedArgv,
    importedSpec:
      opts.baseline === "structured"
        ? toComposeSpec({ command: displayCommand, commandArgv: structuredArgv })
        : null,
    driftSpec: null,
  };
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    query: { service: { findMany: async () => [row] } },
    update: () => ({
      set: (data: Record<string, unknown>) => {
        writes.push(data);
        return { where: async () => undefined };
      },
    }),
  } as unknown as Database;
  return { repo: createServiceRepo(db), writes };
}

describe("reconcileFromCompose reviews pre-#332 command argv", () => {
  it("requires review instead of clobbering a flattened argv while bootstrapping", async () => {
    const { repo, writes } = fakeRepoRow({ baseline: "none" });

    const result = await repo.reconcileFromCompose("proj_1", [
      { name: "app", command: displayCommand, commandArgv: structuredArgv },
    ]);

    expect(writes).toHaveLength(1);
    expect(writes[0].commandArgv).toBeUndefined();
    expect((writes[0].importedSpec as { commandArgv: string[] }).commandArgv).toEqual(
      structuredArgv,
    );
    expect((writes[0].driftSpec as { commandArgv: string[] }).commandArgv).toEqual(
      structuredArgv,
    );
    expect(result.commandArgvReviewNames).toEqual(["app"]);
  });

  it("requires review when a structured baseline exists but operational argv is flattened", async () => {
    const { repo, writes } = fakeRepoRow({ baseline: "structured" });

    const result = await repo.reconcileFromCompose("proj_1", [
      { name: "app", command: displayCommand, commandArgv: structuredArgv },
    ]);

    expect(writes).toHaveLength(1);
    expect(writes[0].commandArgv).toBeUndefined();
    expect((writes[0].driftSpec as { commandArgv: string[] }).commandArgv).toEqual(
      structuredArgv,
    );
    expect(result.commandArgvReviewNames).toEqual(["app"]);
  });

  it("preserves a genuine operator argv edit", async () => {
    const operatorArgv = ["/bin/sh", "-ec", "echo operator override"];
    const { repo, writes } = fakeRepoRow({ baseline: "structured", argv: operatorArgv });

    await repo.reconcileFromCompose("proj_1", [
      { name: "app", command: displayCommand, commandArgv: structuredArgv },
    ]);

    expect(writes).toHaveLength(0);
  });

  it("does not overwrite the exact collision with a possible operator override", async () => {
    const { repo, writes } = fakeRepoRow({
      baseline: "structured",
      argv: commandToArgv(displayCommand)!,
    });

    const result = await repo.reconcileFromCompose("proj_1", [
      { name: "app", command: displayCommand, commandArgv: structuredArgv },
    ]);

    expect(writes).toHaveLength(1);
    expect(writes[0].commandArgv).toBeUndefined();
    expect(result.commandArgvReviewNames).toEqual(["app"]);
  });

  it("requires review before auto-applying an unrelated upstream field change", async () => {
    const { repo, writes } = fakeRepoRow({ baseline: "structured" });

    const result = await repo.reconcileFromCompose("proj_1", [
      {
        name: "app",
        image: "acme/app:new",
        command: displayCommand,
        commandArgv: structuredArgv,
      },
    ]);

    expect(writes).toHaveLength(1);
    expect(writes[0].image).toBeUndefined();
    expect(writes[0].commandArgv).toBeUndefined();
    expect((writes[0].driftSpec as { image: string }).image).toBe("acme/app:new");
    expect(result.commandArgvReviewNames).toEqual(["app"]);
  });
});
