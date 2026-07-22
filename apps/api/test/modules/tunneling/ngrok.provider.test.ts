import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { forward } = vi.hoisted(() => ({ forward: vi.fn() }));
vi.mock("@ngrok/ngrok", () => ({ forward }));

const { reservedDomainsCreate, reservedDomainsList, reservedDomainsDelete, NgrokApiClientCtor } =
  vi.hoisted(() => {
    const reservedDomainsCreate = vi.fn();
    const reservedDomainsList = vi.fn();
    const reservedDomainsDelete = vi.fn();
    const NgrokApiClientCtor = vi.fn().mockImplementation(function () {
      return {
        reservedDomains: {
          create: reservedDomainsCreate,
          list: reservedDomainsList,
          delete: reservedDomainsDelete,
        },
      };
    });
    return { reservedDomainsCreate, reservedDomainsList, reservedDomainsDelete, NgrokApiClientCtor };
  });
vi.mock("@ngrok/ngrok-api", () => ({ Ngrok: NgrokApiClientCtor }));

vi.mock("../../../src/config/env", () => ({
  env: { NGROK_AUTHTOKEN: undefined, NGROK_API_KEY: undefined },
}));

import { env } from "../../../src/config/env";
import { ngrokProvider } from "../../../src/modules/tunneling/providers/ngrok.provider";
import { ProvisionFailedError, SlugTakenError, type TunnelProvisionInput, type TunnelRecord } from "../../../src/modules/tunneling/types";

function input(overrides: Partial<TunnelProvisionInput> = {}): TunnelProvisionInput {
  return { name: "test-tunnel", port: 4000, ...overrides };
}

function makeListener(overrides: { url?: string | null; join?: () => Promise<void> } = {}) {
  return {
    url: vi.fn().mockReturnValue(overrides.url === undefined ? "https://abc123.ngrok-free.app" : overrides.url),
    id: vi.fn().mockReturnValue("lis_123"),
    close: vi.fn().mockResolvedValue(undefined),
    join: overrides.join ?? vi.fn().mockReturnValue(new Promise(() => {})),
  };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  env.NGROK_AUTHTOKEN = "authtok_test";
  env.NGROK_API_KEY = undefined;
});

describe("ngrokProvider.preflight", () => {
  it("rejects when NGROK_AUTHTOKEN is unset", async () => {
    env.NGROK_AUTHTOKEN = undefined;
    await expect(ngrokProvider.preflight()).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining("NGROK_AUTHTOKEN"),
    });
  });

  it("passes when NGROK_AUTHTOKEN is set", async () => {
    await expect(ngrokProvider.preflight()).resolves.toEqual({ ok: true });
  });
});

describe("ngrokProvider.create — no slug (auto-assigned dev-domain)", () => {
  it("probe-connects, closes the probe, and derives the record from the returned URL", async () => {
    const listener = makeListener({ url: "https://sunny-otter-42.ngrok-free.app" });
    forward.mockResolvedValue(listener);

    const record = await ngrokProvider.create(input());

    expect(forward).toHaveBeenCalledWith({ addr: 4000, authtoken: "authtok_test" });
    expect(listener.close).toHaveBeenCalledOnce();
    expect(record).toEqual({
      externalId: "sunny-otter-42.ngrok-free.app",
      slug: "sunny-otter-42.ngrok-free.app",
      publicUrl: "https://sunny-otter-42.ngrok-free.app",
    });
  });

  it("wraps a forward() failure in ProvisionFailedError", async () => {
    forward.mockRejectedValue(new Error("network unreachable"));
    await expect(ngrokProvider.create(input())).rejects.toBeInstanceOf(ProvisionFailedError);
  });

  it("throws ProvisionFailedError if the listener never returns a URL", async () => {
    forward.mockResolvedValue(makeListener({ url: null }));
    await expect(ngrokProvider.create(input())).rejects.toBeInstanceOf(ProvisionFailedError);
  });
});

describe("ngrokProvider.create — slug + NGROK_API_KEY (reserved domain)", () => {
  beforeEach(() => {
    env.NGROK_API_KEY = "apikey_test";
  });

  it("reserves the domain and returns a record without probe-connecting", async () => {
    reservedDomainsCreate.mockResolvedValue({ id: "rd_1", domain: "myapp.ngrok.app" });

    const record = await ngrokProvider.create(input({ slug: "myapp.ngrok.app" }));

    expect(reservedDomainsCreate).toHaveBeenCalledWith({ domain: "myapp.ngrok.app", region: "us" });
    expect(forward).not.toHaveBeenCalled();
    expect(record).toEqual({
      externalId: "rd_1",
      slug: "myapp.ngrok.app",
      publicUrl: "https://myapp.ngrok.app",
    });
  });

  it("treats a conflict as success when we already own the domain", async () => {
    reservedDomainsCreate.mockRejectedValue({ statusCode: 409, msg: "domain already reserved" });
    reservedDomainsList.mockResolvedValue([{ id: "rd_1", domain: "myapp.ngrok.app" }]);

    await expect(ngrokProvider.create(input({ slug: "myapp.ngrok.app" }))).resolves.toMatchObject({
      externalId: "rd_1",
      slug: "myapp.ngrok.app",
    });
  });

  it("throws SlugTakenError on conflict when the domain belongs to someone else", async () => {
    reservedDomainsCreate.mockRejectedValue({ statusCode: 409, msg: "domain already reserved" });
    reservedDomainsList.mockResolvedValue([]);

    await expect(ngrokProvider.create(input({ slug: "myapp.ngrok.app" }))).rejects.toBeInstanceOf(SlugTakenError);
  });

  it("wraps a non-conflict reservation failure in ProvisionFailedError", async () => {
    reservedDomainsCreate.mockRejectedValue({ statusCode: 500, msg: "internal error" });
    await expect(ngrokProvider.create(input({ slug: "myapp.ngrok.app" }))).rejects.toBeInstanceOf(ProvisionFailedError);
  });
});

describe("ngrokProvider.create — slug, no NGROK_API_KEY", () => {
  it("probe-connects to confirm the domain is usable and trusts the SDK's returned URL", async () => {
    const listener = makeListener({ url: "https://myapp.ngrok.app" });
    forward.mockResolvedValue(listener);

    const record = await ngrokProvider.create(input({ slug: "myapp.ngrok.app" }));

    expect(forward).toHaveBeenCalledWith({ addr: 4000, authtoken: "authtok_test", domain: "myapp.ngrok.app" });
    expect(listener.close).toHaveBeenCalledOnce();
    expect(record.publicUrl).toBe("https://myapp.ngrok.app");
  });

  it("throws SlugTakenError when the probe connect fails with a domain-taken message", async () => {
    forward.mockRejectedValue(new Error("this domain is already reserved by another account"));
    await expect(ngrokProvider.create(input({ slug: "myapp.ngrok.app" }))).rejects.toBeInstanceOf(SlugTakenError);
  });

  it("wraps other probe failures in ProvisionFailedError", async () => {
    forward.mockRejectedValue(new Error("boom"));
    await expect(ngrokProvider.create(input({ slug: "myapp.ngrok.app" }))).rejects.toBeInstanceOf(ProvisionFailedError);
  });
});

describe("ngrokProvider.create — per-call context overrides", () => {
  it("prefers context.authtoken / context.apiKey over env vars", async () => {
    reservedDomainsCreate.mockResolvedValue({ id: "rd_1", domain: "myapp.ngrok.app" });

    await ngrokProvider.create(
      input({ slug: "myapp.ngrok.app", context: { authtoken: "override_tok", apiKey: "override_key" } }),
    );

    expect(NgrokApiClientCtor).toHaveBeenCalledWith({ apiToken: "override_key" });
  });
});

describe("ngrokProvider.delete", () => {
  it("is a no-op for a bare hostname — never deletes by name, even with an API key set", async () => {
    env.NGROK_API_KEY = "apikey_test";
    await ngrokProvider.delete("myapp.ngrok.app");
    expect(NgrokApiClientCtor).not.toHaveBeenCalled();
  });

  it("deletes a real reservation id directly, without listing", async () => {
    env.NGROK_API_KEY = "apikey_test";
    await ngrokProvider.delete("rd_1");
    expect(reservedDomainsList).not.toHaveBeenCalled();
    expect(reservedDomainsDelete).toHaveBeenCalledWith("rd_1");
  });

  it("warns and skips if a reservation id needs deleting but no API key is set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await ngrokProvider.delete("rd_1");
    expect(reservedDomainsDelete).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("is best-effort — swallows failures instead of throwing", async () => {
    env.NGROK_API_KEY = "apikey_test";
    reservedDomainsDelete.mockRejectedValue(new Error("api down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(ngrokProvider.delete("rd_1")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe("ngrokProvider.connect + TunnelAgent adapter", () => {
  const record: TunnelRecord = {
    externalId: "myapp.ngrok.app",
    slug: "myapp.ngrok.app",
    publicUrl: "https://myapp.ngrok.app",
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens a listener bound to the record's slug", async () => {
    forward.mockResolvedValue(makeListener());

    await ngrokProvider.connect(record, 4000);

    expect(forward).toHaveBeenCalledWith({ addr: 4000, authtoken: "authtok_test", domain: "myapp.ngrok.app" });
  });

  it("starts connected and exposes an EventEmitter-style on()", async () => {
    forward.mockResolvedValue(makeListener());
    const agent = await ngrokProvider.connect(record, 4000);

    expect(agent.isConnected).toBe(true);
    expect(typeof agent.on).toBe("function");
  });

  it("emits disconnect (not close) when the listener exits without an explicit close()", async () => {
    const join = deferred<void>();
    forward.mockResolvedValue(makeListener({ join: () => join.promise }));
    const agent = await ngrokProvider.connect(record, 4000);

    const disconnect = vi.fn();
    const close = vi.fn();
    agent.on("disconnect", disconnect);
    agent.on("close", close);

    join.resolve();
    await flush();

    expect(agent.isConnected).toBe(false);
    expect(disconnect).toHaveBeenCalledWith(0, expect.stringContaining("exited"));
    expect(close).not.toHaveBeenCalled();
  });

  it("emits disconnect with the error message when the listener task rejects", async () => {
    const join = deferred<void>();
    forward.mockResolvedValue(makeListener({ join: () => join.promise }));
    const agent = await ngrokProvider.connect(record, 4000);

    const disconnect = vi.fn();
    agent.on("disconnect", disconnect);

    join.reject(new Error("session dropped"));
    await flush();

    expect(disconnect).toHaveBeenCalledWith(0, "session dropped");
  });

  it("emits close (not disconnect) when close() was called intentionally", async () => {
    const join = deferred<void>();
    const listener = makeListener({ join: () => join.promise });
    forward.mockResolvedValue(listener);
    const agent = await ngrokProvider.connect(record, 4000);

    const disconnect = vi.fn();
    const close = vi.fn();
    agent.on("disconnect", disconnect);
    agent.on("close", close);

    agent.close();
    expect(agent.isConnected).toBe(false);
    expect(listener.close).toHaveBeenCalledOnce();

    join.resolve();
    await flush();

    expect(close).toHaveBeenCalledOnce();
    expect(disconnect).not.toHaveBeenCalled();
  });
});
