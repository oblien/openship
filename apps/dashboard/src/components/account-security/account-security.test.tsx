// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import LoginPage from "@/app/(auth)/login/page";
import { TwoFactorChallenge } from "@/app/(auth)/two-factor/challenge";
import { TwoFactorSetting } from "@/app/(dashboard)/settings/_components/TwoFactorSetting";
import { PasskeysSetting } from "@/app/(dashboard)/settings/_components/PasskeysSetting";

const h = vi.hoisted(() => ({
  push: vi.fn(),
  toast: vi.fn(),
  email: vi.fn(),
  passkey: vi.fn(),
  enable: vi.fn(),
  verifyTotp: vi.fn(),
  verifyBackupCode: vi.fn(),
  disable: vi.fn(),
  generateBackupCodes: vi.fn(),
  listAccounts: vi.fn(),
  addPassword: vi.fn(),
  addPasskey: vi.fn(),
  deletePasskey: vi.fn(),
  refetch: vi.fn(),
  user: { id: "owner", twoFactorEnabled: false },
  sessionError: null as { message: string } | null,
  passkeys: [{ id: "key-one", name: "Laptop", deviceType: "multiDevice", backedUp: true }],
  params: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push }),
  useSearchParams: () => h.params,
}));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (message: string, vars: Record<string, string>) =>
    message.replace(/\{(\w+)\}/g, (_, key) => vars[key] || ""),
}));
vi.mock("@/components/auth-shell", () => ({
  AuthShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/oauth-buttons", () => ({ OAuthButtons: () => null }));
vi.mock("@/app/(auth)/providers", () => ({
  useAuthContext: () => ({ authMode: "local", selfHosted: false, authProviders: [] }),
}));
vi.mock("@/components/toast", () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.toast }) }));
vi.mock("@/lib/auth-client", () => ({
  signIn: { email: h.email, passkey: h.passkey },
  setAccountPassword: h.addPassword,
  authClient: {
    useSession: () => ({
      data: h.sessionError ? null : { user: h.user },
      error: h.sessionError,
      isPending: false,
      refetch: h.refetch,
    }),
    useListPasskeys: () => ({
      data: h.passkeys,
      error: null,
      isPending: false,
      refetch: h.refetch,
    }),
    listAccounts: h.listAccounts,
    passkey: { addPasskey: h.addPasskey, deletePasskey: h.deletePasskey },
    twoFactor: {
      enable: h.enable,
      verifyTotp: h.verifyTotp,
      verifyBackupCode: h.verifyBackupCode,
      disable: h.disable,
      generateBackupCodes: h.generateBackupCodes,
    },
  },
}));

let root: Root, container: HTMLDivElement;
const copy = baseDictionary.settings.accountSecurity;
const authCopy = baseDictionary.auth.security;
const codes = ["Abcd1-efgh2", "Ijkl3-mnop4"];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("PublicKeyCredential", class {});
  h.user.twoFactorEnabled = false;
  h.sessionError = null;
  h.params = new URLSearchParams("returnTo=%2Fmcp%2Fauthorize%3Fclient_id%3Dexample");
  for (const value of Object.values(h)) if (vi.isMockFunction(value)) value.mockReset();
  h.listAccounts.mockResolvedValue({ data: [{ providerId: "credential" }], error: null });
  h.refetch.mockResolvedValue(undefined);
  h.enable.mockResolvedValue({
    data: {
      totpURI: "otpauth://totp/Openship:owner?secret=JBSWY3HPEHPK3VXP&issuer=Openship",
      backupCodes: codes,
    },
    error: null,
  });
  h.verifyTotp.mockResolvedValue({ data: { token: "test-session" }, error: null });
  h.verifyBackupCode.mockResolvedValue({ data: { token: "test-session" }, error: null });
  h.deletePasskey.mockResolvedValue({ data: { status: true }, error: null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const render = async (component: ReactNode) => {
  await act(async () => root.render(component));
};
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
async function click(label: string) {
  await act(async () => button(label).click());
}
async function fill(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

describe("primary login continuation", () => {
  it.each(["password", "passkey"])(
    "routes %s sign-in to the second factor without losing MCP consent",
    async (method) => {
      h.email.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
      h.passkey.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
      await render(<LoginPage />);
      if (method === "password") {
        await fill("login-email", "owner@example.test");
        await fill("login-password", "test-password");
        await submit();
      } else await click(authCopy.passkeySignIn);
      expect(h.push).toHaveBeenCalledWith(
        "/two-factor?returnTo=%2Fmcp%2Fauthorize%3Fclient_id%3Dexample",
      );
      expect(h.push).not.toHaveBeenCalledWith("/");
    },
  );
});

describe("second factor challenge", () => {
  it("keeps invalid codes visible and gives expired challenges a fresh sign-in path", async () => {
    const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    h.verifyTotp.mockResolvedValueOnce({ error: { code: "INVALID_CODE", message: "Wrong code" } });
    await render(<TwoFactorChallenge />);
    await fill("two-factor-code", "000000");
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Wrong code");
    expect(navigate).not.toHaveBeenCalled();
    h.verifyTotp.mockResolvedValueOnce({ error: { code: "INVALID_TWO_FACTOR_COOKIE" } });
    await submit();
    expect(container.textContent).toContain(authCopy.expired);
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("a")?.href).toContain("/login?returnTo=");
  });

  it("preserves recovery-code case and resumes only the server's verified continuation", async () => {
    const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    h.verifyBackupCode.mockResolvedValue({
      data: { redirectURL: "https://app.example.test/mcp/authorize" },
      error: null,
    });
    await render(<TwoFactorChallenge />);
    await click(authCopy.useRecovery);
    await fill("two-factor-code", " AbCd1-23456 ");
    await submit();
    expect(h.verifyBackupCode).toHaveBeenCalledWith({ code: "AbCd1-23456" });
    expect(h.verifyTotp).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("https://app.example.test/mcp/authorize");
  });
});

describe("account security settings", () => {
  it("offers retry when the session cannot be loaded instead of staying on loading", async () => {
    h.sessionError = { message: "Connection unavailable" };
    await render(<TwoFactorSetting />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Connection unavailable",
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    await click(copy.retry);
    expect(h.refetch).toHaveBeenCalled();
  });

  it("confirms the authenticator before showing recovery codes and asks the user to save them", async () => {
    await render(<TwoFactorSetting />);
    await click(copy.enable);
    await fill("security-password", "test-password");
    await submit();
    expect(h.enable).toHaveBeenCalledWith({ password: "test-password" });
    expect(container.querySelector("svg title")?.textContent).toBe(copy.scanTitle);
    expect(container.textContent).not.toContain(codes[0]);
    h.verifyTotp.mockResolvedValueOnce({ error: { message: "Invalid authenticator code" } });
    await fill("enroll-authenticator-code", "123456");
    await submit();
    expect(container.textContent).toContain("Invalid authenticator code");
    expect(container.textContent).not.toContain(codes[0]);
    await submit();
    expect(container.textContent).toContain(codes[0]);
    expect(button(copy.done).disabled).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    expect(button(copy.done).disabled).toBe(false);
    await click(copy.done);
    expect(container.textContent).not.toContain(codes[0]);
    expect(container.querySelector("#authenticator-secret")).toBeNull();
  });

  it("supports OAuth-only accounts without accepting mismatched password confirmation", async () => {
    h.listAccounts.mockResolvedValue({ data: [{ providerId: "google" }], error: null });
    h.addPassword.mockResolvedValue({ data: { status: true }, error: null });
    await render(<TwoFactorSetting />);
    await click(copy.addPassword);
    await fill("security-password", "new-password");
    await fill("security-confirm-password", "different-password");
    await submit();
    expect(h.addPassword).not.toHaveBeenCalled();
    expect(container.textContent).toContain(copy.passwordMismatch);
    await fill("security-confirm-password", "new-password");
    await submit();
    expect(h.addPassword).toHaveBeenCalledWith("new-password");
    expect(button(copy.enable)).toBeTruthy();
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it("can manage existing passkeys in an unsupported browser and confirms deletion inline", async () => {
    vi.stubGlobal("isSecureContext", false);
    await render(<PasskeysSetting />);
    expect(container.textContent).toContain(copy.passkeyUnsupported);
    expect(container.textContent).toContain("Laptop");
    expect(button(copy.passkeyAdd)).toBeUndefined();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Remove Laptop"]')!.click(),
    );
    expect(h.deletePasskey).not.toHaveBeenCalled();
    await click(copy.cancel);
    expect(h.deletePasskey).not.toHaveBeenCalled();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Remove Laptop"]')!.click(),
    );
    await click(copy.remove);
    expect(h.deletePasskey).toHaveBeenCalledWith({ id: "key-one" });
  });
});
