"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Error boundary for the whole (dashboard) segment. Catches render errors in any
 * dashboard page AND its nested layouts (e.g. the billing layout's header) so a
 * single crashing screen degrades to a recoverable in-app error instead of
 * bubbling all the way to global-error.tsx and replacing the entire app. The
 * dashboard shell (sidebar) from the (dashboard) layout stays mounted around it.
 *
 * NOTE: a segment's own error.tsx does NOT wrap its own layout — only children —
 * so this lives at the (dashboard) level to cover crashes in child layouts.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[dashboard] segment error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <h1 className="th-text-heading text-xl font-semibold">Something went wrong</h1>
      <p className="th-text-body mt-2 max-w-md text-sm leading-relaxed">
        This page hit an unexpected error. Try again — if it keeps happening, head
        back to your projects.
      </p>
      {error?.digest && (
        <p className="th-text-muted mt-3 font-mono text-xs">{error.digest}</p>
      )}
      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={() => reset()}
          className="th-text-title rounded-full border px-4 py-2 text-sm font-medium transition-colors hover:opacity-80"
          style={{ borderColor: "var(--th-bd-subtle)" }}
        >
          Try again
        </button>
        <Link
          href="/projects"
          className="th-text-secondary rounded-full px-4 py-2 text-sm font-medium transition-colors hover:opacity-80"
        >
          Go to projects
        </Link>
      </div>
    </div>
  );
}
