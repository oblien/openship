import { authClient } from "@/lib/auth-client";

/**
 * Retrieve the current session token for use in contexts where cookies
 * cannot be sent automatically (e.g. EventSource / SSE URLs).
 *
 * Calls Better Auth's `getSession()` which sends the httpOnly cookie
 * and returns the session object including the token string.
 */
export async function getAuthToken(): Promise<string> {
  const { data } = await authClient.getSession();
  return data?.session?.token ?? "";
}
