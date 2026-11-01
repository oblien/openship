import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { AuthProviders } from "./providers";
import LoginPage from "./login/page";
import RegisterPage from "./register/page";
import ForgotPasswordPage from "./forgot-password/page";
import ResetPasswordPage from "./reset-password/page";

const h = vi.hoisted(() => ({ query: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(h.query),
}));
beforeEach(() => { h.query = ""; });
vi.mock("@/components/auth-shell", () => ({ AuthShell: ({ children }: { children: ReactNode }) => children }));

function render(Page: typeof LoginPage, selfHosted: boolean, authMode: "local" | "none" | "cloud" = "local") {
  return renderToStaticMarkup(
    <I18nProvider>
      <AuthProviders selfHosted={selfHosted} authMode={authMode} cloudAuthUrl="https://app.openship.io"
        authProviders={[
          { id: "github", kind: "social" },
          { id: "oidc", kind: "oidc", name: "Authentik" },
        ]}>
        <Page />
      </AuthProviders>
    </I18nProvider>,
  );
}

describe("auth pages use the advertised login providers", () => {
  it.each([LoginPage, RegisterPage, ForgotPasswordPage, ResetPasswordPage])("retains the app in auth navigation", Page => {
    const destination = "/apps/new/minio";
    h.query = new URLSearchParams({ returnTo: destination }).toString();
    const html = render(Page, false);
    expect(html).toContain(`returnTo=${encodeURIComponent(destination)}`);
    expect(html).not.toContain('href="/login"');
  });
  it.each([true, false])("renders only configured providers on the login page (self-hosted: %s)", selfHosted => {
    const html = render(LoginPage, selfHosted);
    expect(html).toContain("Continue with GitHub");
    expect(html).toContain("Continue with Authentik");
    expect(html).not.toContain("Continue with Google");
  });

  it("uses the same provider list on the registration page", () => {
    const html = render(RegisterPage, false);
    expect(html).toContain("Continue with GitHub");
    expect(html).toContain("Continue with Authentik");
    expect(html).not.toContain("Continue with Google");
  });

  it.each(["none", "cloud"] as const)("keeps the existing %s login flow", mode => {
    const html = render(LoginPage, true, mode);
    expect(html).not.toContain("Continue with GitHub");
    expect(html).not.toContain("Continue with Authentik");
    expect(html).not.toContain("Continue with Google");
  });
});
