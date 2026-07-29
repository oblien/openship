import { describe, expect, it, vi, afterEach } from "vitest";
import { sshManager } from "./ssh-manager";
import { repos } from "@repo/db";
import { createHostExecutor } from "@repo/adapters";

// Mock the DB and adapters using Vitest
vi.mock("@repo/db", () => ({
  repos: {
    server: {
      get: vi.fn().mockImplementation(async (id: string) => {
        if (id === "local-host-id") {
          return { id, isLocal: true, sshHost: "127.0.0.1" };
        }
        return undefined;
      }),
    },
  },
}));

vi.mock("@repo/adapters", () => ({
  createHostExecutor: vi.fn().mockImplementation(() => ({
    dispose: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe("SshConnectionManager", () => {
  afterEach(() => {
    // Clear the manager's state between tests
    (sshManager as any).servers.clear();
    (sshManager as any).connecting.clear();
    vi.clearAllMocks();
  });

  it("acquiring local host multiple times returns the same pooled executor", async () => {
    // Acquire the first time
    const exec1 = await sshManager.acquire("local-host-id");
    expect(exec1).toBeDefined();

    // Acquire a second time
    const exec2 = await sshManager.acquire("local-host-id");
    
    // It should be the exact same instance (cached)
    expect(exec1).toBe(exec2);
    
    // The pool should only have 1 active server connection
    expect((sshManager as any).servers.size).toBe(1);
    
    // The createHostExecutor factory should only be called once
    expect(createHostExecutor).toHaveBeenCalledTimes(1);
  });
});
