"use client";

import { useEffect } from "react";

/**
 * OAuth callback landing page — auto-closes the popup/window.
 *
 * Better Auth redirects here after successful GitHub OAuth in desktop mode.
 * The popup closes, and the opener detects it via the authWindow middleware.
 */
export default function OAuthCallbackClose() {
  useEffect(() => {
    // Give a brief moment for cookies to settle, then close
    const timer = setTimeout(() => window.close(), 300);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <p className="text-sm text-muted-foreground">Authenticated — closing…</p>
    </div>
  );
}
