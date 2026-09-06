export type TwoFactorResultShape = {
  data?: ({ token?: string | null } & Record<string, unknown>) | null;
  error?: { code?: string | null; message?: string | null } | null;
};

export type TwoFactorNext =
  | { kind: "session"; href: string }
  | { kind: "expired" }
  | { kind: "error"; code: string | null; message: string | null };

export function twoFactorNext(
  result: TwoFactorResultShape,
  postLoginUrl?: string | null,
): TwoFactorNext {
  if (result.data?.token) {
    return { kind: "session", href: postLoginUrl || "/" };
  }

  if (result.error?.code === "INVALID_TWO_FACTOR_COOKIE") {
    return { kind: "expired" };
  }

  return {
    kind: "error",
    code: result.error?.code ?? null,
    message: result.error?.message ?? null,
  };
}
