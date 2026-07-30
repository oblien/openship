"use client";

import { useEffect } from "react";
import { RefreshCw, LayoutGrid } from "lucide-react";
import { ErrorView } from "@/components/error-view";
import { useI18n } from "@/components/i18n-provider";

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
  const { t } = useI18n();
  const c = t.chrome;

  useEffect(() => {
    console.error("[dashboard] segment error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-6 py-10">
      <ErrorView
        variant="crash"
        brand={t.brand}
        title={c.error.title}
        description={c.error.description}
        code={error?.digest}
        codeLabel={c.error.refCode}
        actions={[
          {
            label: c.error.tryAgain,
            onClick: () => reset(),
            icon: <RefreshCw className="size-4" />,
          },
          {
            label: c.error.goToProjects,
            href: "/projects",
            icon: <LayoutGrid className="size-4" />,
            variant: "secondary",
          },
        ]}
        docsLabel={c.errorLinks.docs}
        githubLabel={c.errorLinks.github}
      />
    </div>
  );
}
