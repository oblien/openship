// @vitest-environment happy-dom
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, INITIAL_STATE } from "@/context/deployment/types";
import { baseDictionary } from "@/i18n";
import BuildPage from "./page";

const h = vi.hoisted(() => ({
  id: "dep-new", scope: "account-a", search: "", state: {} as any,
  load: vi.fn(), connect: vi.fn(), redeploy: vi.fn(), modal: vi.fn(), pricing: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: h.id }), useRouter: () => h.router,
  useSearchParams: () => new URLSearchParams(h.search),
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => h.scope }));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ isLoggedIn: true }) }));
vi.mock("@/context/DeploymentContext", () => ({ useDeployment: () => ({
  state: h.state, config: DEFAULT_CONFIG, loadBuildSession: h.load, connectToBuild: h.connect,
  redeploy: h.redeploy, maybeOpenCredentialModal: h.modal,
}) }));
vi.mock("@/components/i18n-provider", () => ({ useI18n: () => ({ t: baseDictionary }) }));
vi.mock("@/hooks/useCloudDeployPricing", () => ({ useCloudDeployPricing: () => h.pricing }));
vi.mock("@/components/import-project/BuildSkeleton", () => ({ default: () => <div>Loading attempt</div> }));
vi.mock("@/components/import-project/DeploymentProcessing", () => ({ default: () => <div>{h.state.deploymentId}:{h.state.deploymentFailed ? "Failed" : "Building"}</div> }));
vi.mock("@/components/import-project/ComposeDeploymentProcessing", () => ({ default: () => null }));
vi.mock("@/components/resource-not-found", () => ({ ResourceNotFound: ({ title, description }: any) => <div role="alert">{title}{description}</div> }));

let host: HTMLDivElement, root: Root;
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const render = () => act(async () => root.render(<BuildPage />));
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.id = "dep-new"; h.scope = "account-a"; h.search = "";
  h.state = { ...INITIAL_STATE, deploymentId: "dep-old", deploymentFailed: true, errorCode: "OLD_FAILURE" };
  h.load.mockResolvedValue({ success: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("never paints another attempt's failure or opens its recovery modal", async () => {
  const request = deferred<any>(); h.load.mockReturnValue(request.promise);
  await render();
  expect(host.textContent).toBe("Loading attempt");
  expect(h.load).toHaveBeenCalledExactlyOnceWith("dep-new");
  expect(h.modal).not.toHaveBeenCalled(); expect(h.pricing).not.toHaveBeenCalled();
  h.state = { ...INITIAL_STATE, deploymentId: h.id, isDeploying: true };
  await act(async () => request.resolve({ success: true }));
  expect(host.textContent).toBe("dep-new:Building");
});

it("reads the server on return even when the retained context says it is deploying", async () => {
  h.state = { ...INITIAL_STATE, deploymentId: h.id, isDeploying: true };
  await render();
  expect(h.load).toHaveBeenCalledExactlyOnceWith(h.id);
  expect(h.connect).not.toHaveBeenCalled();
  await render(); expect(h.load).toHaveBeenCalledTimes(1);
});

it("ignores the previous route's delayed not-found response", async () => {
  const old = deferred<any>(); h.load.mockReturnValueOnce(old.promise);
  await render();
  h.id = "dep-second"; h.state = { ...INITIAL_STATE, deploymentId: h.id, isDeploying: true };
  await render();
  await act(async () => old.resolve({ success: false, notFound: true }));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toBe("dep-second:Building");
});

it("clears a failed load on a Cloud account change, even with the same route", async () => {
  h.load.mockResolvedValueOnce({ success: false, error: "First account unavailable" });
  await render(); expect(host.textContent).toContain("First account unavailable");
  h.scope = "account-b";
  const next = deferred<any>(); h.load.mockReturnValueOnce(next.promise);
  await render(); expect(host.textContent).toBe("Loading attempt");
  expect(h.load).toHaveBeenCalledTimes(2);
  h.state = { ...INITIAL_STATE, deploymentId: h.id, isDeploying: true };
  await act(async () => next.resolve({ success: true }));
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("handles Strict Mode effect replay without losing a load failure", async () => {
  h.load.mockResolvedValue({ success: false, error: "Retry available" });
  await act(async () => root.render(<StrictMode><BuildPage /></StrictMode>));
  expect(host.textContent).toContain("Retry available");
});

it("shows the original attempt after a rejected deep-link retry, without submitting twice", async () => {
  h.search = "redeploy=true";
  h.state = { ...INITIAL_STATE, deploymentId: h.id, deploymentFailed: true };
  h.redeploy.mockResolvedValue(null);
  await act(async () => root.render(<StrictMode><BuildPage /></StrictMode>));
  expect(h.redeploy).toHaveBeenCalledExactlyOnceWith(h.id, undefined);
  expect(h.load).toHaveBeenCalledExactlyOnceWith(h.id);
  expect(host.textContent).toBe("dep-new:Failed");
});
