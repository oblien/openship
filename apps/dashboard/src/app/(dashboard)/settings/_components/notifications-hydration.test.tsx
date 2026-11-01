// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const pending = new Promise<never>(() => {});
  return {
    pending,
    session: {
      data: null as { user: TestUser } | null,
      isPending: true,
    },
    categories: vi.fn<() => Promise<unknown>>(() => pending),
    channels: vi.fn<() => Promise<unknown>>(() => pending),
    subscriptions: vi.fn<() => Promise<unknown>>(() => pending),
    defaults: vi.fn<() => Promise<unknown>>(() => pending),
    fullOrganization: vi.fn<() => Promise<unknown>>(() => pending),
    getSession: vi.fn(),
    showToast: vi.fn(),
  };
});

type TestUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
};

const steve: TestUser = {
  id: "user-steve",
  name: "Steve",
  email: "steve@ven.com.au",
  emailVerified: true,
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => ({ get: (key: string) => (key === "tab" ? "notifications" : null) }),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    organization: { getFullOrganization: mocks.fullOrganization },
    getSession: mocks.getSession,
  },
  useSession: () => mocks.session,
  signOut: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  notificationsApi: {
    listCategories: mocks.categories,
    listChannels: mocks.channels,
    listSubscriptions: mocks.subscriptions,
    listDefaults: mocks.defaults,
  },
  getApiErrorMessage: (error: unknown) => String(error),
}));

vi.mock("@/lib/api/system", () => ({
  systemApi: {
    containerIssues: vi.fn().mockResolvedValue({ total: 0 }),
  },
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));

vi.mock("@/components/notifications/NotificationDeliveryHistory", () => ({
  NotificationDeliveryHistory: () => null,
}));

import { I18nProvider } from "@/components/i18n-provider";
import { AuthProvider } from "@/context/AuthContext";
import { PlatformProvider } from "@/context/PlatformContext";
import { NotificationsTab } from "./NotificationsTab";
import { SettingsSidebar } from "./SettingsSidebar";

let host: HTMLDivElement;
let root: Root | undefined;

function view(children: React.ReactNode) {
  return (
    <I18nProvider>
      <AuthProvider initialUser={steve}>
        <PlatformProvider selfHosted deployMode="docker">
          {children}
        </PlatformProvider>
      </AuthProvider>
    </I18nProvider>
  );
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  mocks.session.data = null;
  mocks.session.isPending = true;
  mocks.categories.mockImplementation(() => mocks.pending);
  mocks.channels.mockImplementation(() => mocks.pending);
  mocks.subscriptions.mockImplementation(() => mocks.pending);
  mocks.defaults.mockImplementation(() => mocks.pending);
  mocks.fullOrganization.mockImplementation(() => mocks.pending);
  mocks.getSession.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.clearAllMocks();
});

describe("notification settings hydration", () => {
  it("keeps the server-seeded account header stable when the client session cache resolves first", async () => {
    const element = view(
      <>
        <NotificationsTab />
        <SettingsSidebar />
      </>,
    );

    host.innerHTML = renderToString(element);
    expect(host.textContent).toContain(steve.email);

    // Better Auth may finish its browser request after SSR but before this
    // settings chunk hydrates. Both renders must still use the same seeded user.
    mocks.session.data = { user: steve };
    mocks.session.isPending = false;
    const recoverableError = vi.fn();

    await act(async () => {
      root = hydrateRoot(host, element, { onRecoverableError: recoverableError });
    });

    expect(recoverableError).not.toHaveBeenCalled();
    expect(host.textContent).toContain(steve.email);
  });

  it("resolves notification admin controls from the seeded user without a second session request", async () => {
    mocks.session.data = { user: steve };
    mocks.session.isPending = false;
    mocks.categories.mockResolvedValue({
      categories: [
        {
          id: "deploy.failed",
          group: "deployments",
          label: "Deployment failed",
          description: "A deployment did not complete.",
          defaultEnabled: true,
        },
      ],
      groups: [{ id: "deployments", label: "Deployments" }],
    });
    mocks.channels.mockResolvedValue({ channels: [] });
    mocks.subscriptions.mockResolvedValue({ subscriptions: [] });
    mocks.defaults.mockResolvedValue({ defaults: [] });
    mocks.fullOrganization.mockResolvedValue({
      data: { id: "org-ven", members: [{ userId: steve.id, role: "admin" }] },
    });

    await act(async () => {
      root = createRoot(host);
      root.render(view(<NotificationsTab />));
    });

    const channelKinds = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("1 channels"),
    );
    expect(channelKinds).toBeDefined();
    expect(channelKinds?.disabled).toBe(false);
    expect(mocks.fullOrganization).toHaveBeenCalledOnce();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
});
