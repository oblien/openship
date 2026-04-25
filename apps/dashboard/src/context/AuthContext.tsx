"use client";

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useSession, signOut } from "@/lib/auth-client";
import { useRouter } from "next/navigation";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  role?: string;
};

type AuthState = {
  /** The authenticated user, or `null` when logged-out / loading. */
  user: AuthUser | null;
  /** Whether a session request is currently in flight. */
  isLoading: boolean;
  /** Shorthand: `!!user` — safe to use after `isLoading` is false. */
  isLoggedIn: boolean;
  /** Sign the user out and redirect to `/login`. */
  logout: () => Promise<void>;
};

/* ------------------------------------------------------------------ */
/*  Context                                                           */
/* ------------------------------------------------------------------ */

const AuthContext = createContext<AuthState | undefined>(undefined);

/* ------------------------------------------------------------------ */
/*  Provider                                                          */
/* ------------------------------------------------------------------ */

export function AuthProvider({
  children,
  initialUser = null,
}: {
  children: ReactNode;
  initialUser?: AuthUser | null;
}) {
  const router = useRouter();
  const [hasHydrated, setHasHydrated] = useState(false);

  /*
   * `useSession()` is Better Auth's React hook.
   * It sends the httpOnly cookie to the API and returns:
   *   data  – { user, session } | null
   *   isPending – true while the request is in flight
   *   error – set if the request failed
   */
  const { data: session, isPending } = useSession();

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  const sessionUser: AuthUser | null = session?.user ?? null;
  const user: AuthUser | null =
    sessionUser ?? (isPending || !hasHydrated ? initialUser : null);
  const isLoading = isPending;
  const isLoggedIn = !!user;

  const logout = useCallback(async () => {
    await signOut();
    router.push("/login");
  }, [router]);

  return (
    <AuthContext.Provider value={{ user, isLoading, isLoggedIn, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/**
 * Access the current authentication state from any client component.
 *
 * ```tsx
 * const { user, isLoggedIn, isLoading, logout } = useAuth();
 * ```
 */
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (ctx === undefined) {
    throw new Error("useAuth must be used within an <AuthProvider>");
  }
  return ctx;
}
