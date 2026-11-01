// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import AcceptInvitePage from "./page";
import { getActiveOrganizationId, setActiveOrganizationId } from "@/lib/api/client";

const h = vi.hoisted(() => ({
  id: "invite1", session: { user: { email: "member@example.test" } } as { user: { email: string } } | null,
  get: vi.fn(), post: vi.fn(), accept: vi.fn(), push: vi.fn(), signOut: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: h.id }), useRouter: () => ({ push: h.push }) }));
vi.mock("@/lib/api", () => ({ api: { get: h.get, post: h.post } }));
vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: h.signOut, organization: { acceptInvitation: h.accept, rejectInvitation: vi.fn() } },
  useSession: () => ({ data: h.session, isPending: false }),
}));
vi.mock("@/hooks/useDeploymentInfo", () => ({ useDeploymentInfo: () => null }));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? key),
}));
const m = baseDictionary.misc.acceptInvite;
const preview = () => ({ data: {
  invitation: { email: "member@example.test", role: "member", status: "pending" },
  organization: { id: "org1", name: "Team" }, accountCreation: "invited",
  inviter: { name: "Alex" },
} });
const accepted = { data: { invitation: { organizationId: "org1" } } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  h.id = "invite1";
  h.session = { user: { email: "member@example.test" } };
  h.get.mockReset().mockResolvedValue(preview());
  h.post.mockReset().mockResolvedValue({});
  h.accept.mockReset().mockResolvedValue(accepted);
  h.push.mockReset();
  h.signOut.mockReset().mockResolvedValue({});
  setActiveOrganizationId("previous-org");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(<AcceptInvitePage />));
async function accept() {
  const button = [...container.querySelectorAll("button")].find(button => button.textContent === m.accept);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it.each(["success", "failure"])("ignores a late preview %s after acceptance", async (outcome) => {
  await render();
  const late = deferred<ReturnType<typeof preview>>();
  h.get.mockReturnValueOnce(late.promise);
  h.session = { user: { email: "MEMBER@example.test" } };
  await render();
  await accept();
  expect(container.textContent).toContain(m.acceptedTitle);
  await act(async () => {
    if (outcome === "success") late.resolve(preview());
    else late.reject(new Error("Invitation already accepted"));
  });
  expect(container.textContent).toContain(m.acceptedTitle);
  expect(container.textContent).not.toContain("Invitation already accepted");
});

it("does not fetch a second preview during an acceptance or after completion", async () => {
  await render();
  const pending = deferred<typeof accepted>();
  h.accept.mockReturnValueOnce(pending.promise);
  await accept();
  h.session = { user: { email: "MEMBER@example.test" } };
  await render();
  expect(h.get).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(accepted));
  h.session = null;
  await render();
  expect(h.get).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain(m.acceptedTitle);
});

it("does not apply an old acceptance to another invitation", async () => {
  await render();
  const pending = deferred<typeof accepted>();
  h.accept.mockReturnValueOnce(pending.promise);
  await accept();
  h.id = "invite2";
  await render();
  await act(async () => pending.resolve(accepted));
  expect(container.textContent).not.toContain(m.acceptedTitle);
  await act(async () => vi.advanceTimersByTime(1500));
  expect(h.push).not.toHaveBeenCalled();
});

it("keeps an acceptance error instead of replacing it with an older preview", async () => {
  await render();
  const late = deferred<ReturnType<typeof preview>>();
  h.get.mockReturnValueOnce(late.promise);
  h.session = { user: { email: "MEMBER@example.test" } };
  await render();
  h.accept.mockResolvedValueOnce({ error: { message: "Unable to accept right now" } });
  await accept();
  await act(async () => late.resolve(preview()));
  expect(container.textContent).toContain("Unable to accept right now");
});

it("does not redirect after leaving during an acceptance", async () => {
  await render();
  const pending = deferred<typeof accepted>();
  h.accept.mockReturnValueOnce(pending.promise);
  await accept();
  await act(async () => root.render(null));
  await act(async () => pending.resolve(accepted));
  await act(async () => vi.advanceTimersByTime(1500));
  expect(h.push).not.toHaveBeenCalled();
});

it("submits one acceptance for repeated clicks before React rerenders", async () => {
  await render();
  const pending = deferred<typeof accepted>();
  h.accept.mockReturnValueOnce(pending.promise);
  const button = [...container.querySelectorAll("button")].find(button => button.textContent === m.accept)!;
  await act(async () => { button.click(); button.click(); });
  expect(h.accept).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(accepted));
});

it("selects the accepted organization without a second grant-materialization request", async () => {
  await render(); await accept();
  expect(getActiveOrganizationId()).toBe("org1");
  expect(h.post).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(1500));
  expect(h.push).toHaveBeenCalledWith("/");
});

it("keeps the current organization after a failed claim", async () => {
  h.accept.mockResolvedValueOnce({ error: { message: "Invitation expired" } });
  await render(); await accept();
  expect(getActiveOrganizationId()).toBe("previous-org");
  expect(h.push).not.toHaveBeenCalled();
});

it("shows the inviter, workspace and role before accepting", async () => {
  await render();
  expect(container.textContent).toContain("Alex");
  expect(container.textContent).toContain("Team");
  expect(container.textContent).toContain("member");
  expect(h.accept).not.toHaveBeenCalled();
});

it("keeps the invitation when switching from the wrong signed-in account", async () => {
  h.session = { user: { email: "someone-else@example.test" } };
  const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  try {
    await render();
    expect(h.accept).not.toHaveBeenCalled();
    const button = [...container.querySelectorAll("button")].find(item => item.textContent === m.switchAccount)!;
    await act(async () => button.click());
    expect(h.signOut).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/login?returnTo=%2Faccept-invite%2Finvite1");
  } finally { navigate.mockRestore(); }
});
