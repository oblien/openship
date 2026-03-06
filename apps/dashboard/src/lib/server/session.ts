import "server-only";
import { cache } from "react";
import { serverApi, ServerApiError } from "./api";

/**
 * Session and user types returned by Better Auth's `/api/auth/get-session`.
 */
export type Session = {
  id: string;
  userId: string;
  expiresAt: string;
  token: string;
  createdAt: string;
  updatedAt: string;
  ipAddress?: string;
  userAgent?: string;
};

export type User = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  createdAt: string;
  updatedAt: string;
  role: string;
};

export type SessionData = { session: Session; user: User };

/**
 * Get the current session from the API.
 *
 * Wrapped with `React.cache()` so multiple server components
 * calling `getSession()` in the same request share one fetch.
 *
 * Returns the session data or `null` if unauthenticated.
 */
export const getSession = cache(async (): Promise<SessionData | null> => {
  try {
    const data = await serverApi.get<SessionData>("/api/auth/get-session", {
      cache: "no-store",
    });
    return data;
  } catch (err) {
    if (err instanceof ServerApiError && err.status === 401) {
      return null;
    }
    // Network errors, timeouts, etc. — treat as unauthenticated
    // to fall back to login rather than crashing the page.
    return null;
  }
});
