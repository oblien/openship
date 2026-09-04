export type LoginResultShape = {
  data?: ({ twoFactorRedirect?: boolean } & Record<string, unknown>) | null;
  error?: { code?: string | null; message?: string | null } | null;
};

export type LoginNext =
  | { kind: "verify-email"; href: string }
  | { kind: "two-factor"; href: string }
  | { kind: "error"; message: string | null }
  | { kind: "session"; href: string };

export function loginNext(
  result: LoginResultShape,
  opts: {
    email: string;
    twoFactorHref: string;
    postLoginUrl?: string | null;
  },
): LoginNext {
  if (result.error) {
    if (
      result.error.code === "EMAIL_NOT_VERIFIED" ||
      result.error.message?.toLowerCase().includes("verify")
    ) {
      return {
        kind: "verify-email",
        href: `/verify-email?email=${encodeURIComponent(opts.email)}`,
      };
    }

    return { kind: "error", message: result.error.message ?? null };
  }

  if (result.data?.twoFactorRedirect === true) {
    return { kind: "two-factor", href: opts.twoFactorHref };
  }

  return { kind: "session", href: opts.postLoginUrl || "/" };
}
