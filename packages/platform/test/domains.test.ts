import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@repo/contracts";
import { createAuthorization, createDomainOperations, createDnsOperations, type DomainDependencies, type ExecutionContext } from "../src";
import { alice, authorizationFixture } from "./fixtures";
import { domainFixture, dnsCredentialFixture } from "../../contracts/test/fixtures";

let state: ReturnType<typeof authorizationFixture>;
let ctx: ExecutionContext;
let domains: ReturnType<typeof createDomainOperations>;
const get = vi.fn(), create = vi.fn(), verifyPending = vi.fn(), unsubscribe = vi.fn();
let write: (event: string, data: string) => boolean;
beforeEach(async () => {
  vi.clearAllMocks();
  state = authorizationFixture();
  state.members.set("org-a:alice", { id: "member-a", role: "owner" });
  state.members.set("org-b:alice", { id: "member-b", role: "owner" });
  state.projects.set("project-a", { organizationId: "org-a" });
  state.projects.set("project-b", { organizationId: "org-b" });
  state.domains.set("domain-a", { projectId: "project-a" });
  state.domains.set("domain-b", { projectId: "project-b" });
  const authorization = createAuthorization(state);
  ctx = await authorization.resolveScope(alice, "org-a");
  get.mockResolvedValue(domainFixture());
  create.mockResolvedValue({ domain: domainFixture(), records: { mode: "external", records: [] } });
  domains = createDomainOperations(authorization, {
    collection: { create }, resources: { get }, scoped: { verifyPending },
    subscribe: () => (send) => {
      write = send;
      send("session", JSON.stringify({ type: "session" }));
      return { success: true, unsubscribe };
    },
  } as unknown as DomainDependencies);
});

describe("domain operation boundaries", () => {
  it("keeps tenant scope fixed even when the caller belongs to both organizations", async () => {
    await expect(domains.get(ctx, "domain-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(domains.create(ctx, "project-b", { hostname: "app.example.com" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(get).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it("inherits project grants, refreshes them, and snapshots input before authorization", async () => {
    state.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    state.grants.set("org-a:alice:project:project-a", { permissions: ["write"] });
    const input = { hostname: "original.example.com" };
    const pending = domains.create(ctx, "project-a", input);
    input.hostname = "changed.example.com";
    await pending;
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ role: "restricted" }), "project-a", { hostname: "original.example.com" });
    expect((await domains.get(ctx, "domain-a")).data.id).toBe("domain-a");
    state.grants.clear();
    await expect(domains.get(ctx, "domain-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("rejects invalid batch limits and caller-supplied organization overrides before work", async () => {
    await expect(domains.verifyPending(ctx, { limit: -1 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(domains.verifyPending(ctx, { organizationId: "org-b" } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(verifyPending).not.toHaveBeenCalled();
  });
  it("delivers the terminal verification event and closes without another read hanging", async () => {
    const iterator = domains.verifyStream(ctx, "domain-a")[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.event).toBe("session");
    write("complete", JSON.stringify({ type: "complete", status: "completed" }));
    expect((await iterator.next()).value?.event).toBe("complete");
    expect((await iterator.next()).done).toBe(true);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("stops disclosure and unsubscribes after membership revocation", async () => {
    const iterator = domains.verifyStream(ctx, "domain-a")[Symbol.asyncIterator]();
    await iterator.next();
    state.members.delete("org-a:alice");
    write("log", "private certificate log");
    await expect(iterator.next()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("cancels a waiting verification stream without retaining the subscriber", async () => {
    const abort = new AbortController();
    const iterator = domains.verifyStream(ctx, "domain-a", {}, { signal: abort.signal })[Symbol.asyncIterator]();
    await iterator.next();
    const pending = iterator.next();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("organization-scoped DNS operations", () => {
  it("requires settings permission and actual administrator membership for credential writes", async () => {
    const authorization = createAuthorization(state);
    const addCredential = vi.fn(async () => dnsCredentialFixture());
    const requireAdmin = vi.fn(async (context: ExecutionContext) => {
      const member = await state.repos.member.find(context.organizationId, context.userId);
      if (!["owner", "admin"].includes(member?.role ?? "")) throw new AppError("Requires admin role", 403, "INSUFFICIENT_ROLE");
    });
    const dns = createDnsOperations(authorization, { operations: { addCredential } as never, requireAdmin });
    const input = { provider: "cloudflare" as const, name: "Production", apiToken: "private" };
    state.members.set("org-a:alice", { id: "member-a", role: "member" });
    await expect(dns.addCredential(ctx, input)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(addCredential).not.toHaveBeenCalled();
    state.members.set("org-a:alice", { id: "member-a", role: "owner" });
    const identity = { ...alice, tokenScope: { tokenId: "token" }, credential: { organizationId: "org-a", readOnly: false } };
    const tokenContext = await authorization.resolveScope(identity, "org-a");
    await expect(dns.addCredential(tokenContext, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    state.tokenGrants.set("token:settings:*", { permissions: ["admin"] });
    expect((await dns.addCredential(tokenContext, input)).data.tokenMasked).not.toBe("private");
    expect(addCredential).toHaveBeenCalledOnce();
  });
  it("refuses a provider response containing plaintext or encrypted tokens", async () => {
    const getCredential = vi.fn(async () => ({ ...dnsCredentialFixture(), apiToken: "must-not-leave-core" }));
    const dns = createDnsOperations(createAuthorization(state), {
      operations: { getCredential } as never, requireAdmin: async () => {},
    });
    await expect(dns.getCredential(ctx, "dns-a")).rejects.toMatchObject({ code: "INVALID_OPERATION_RESPONSE" });
  });
});
