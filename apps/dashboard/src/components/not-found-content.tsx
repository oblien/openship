"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { NotFoundView } from "@/components/not-found-view";
import { useI18n } from "@/components/i18n-provider";

/**
 * Client wrapper so the 404 copy is localized — the not-found pages
 * themselves are server components and can't call the client `useI18n` hook.
 * Rendered inside I18nProvider (mounted in the root layout), so it resolves
 * in every context: logged-out AuthShell, in-dashboard, and the global miss.
 */
export function NotFoundContent({ variant = "global" }: { variant?: "global" | "dashboard" }) {
  const { t } = useI18n();
  const nf = t.chrome.notFound;
  return (
    <NotFoundView
      title={nf.title}
      description={variant === "dashboard" ? nf.descDashboard : nf.descGlobal}
      actions={[
        { href: "/", label: nf.backToDashboard, icon: <UiIcon name="home" className="size-4" /> },
        { href: "/deployments", label: nf.viewDeployments, icon: <UiIcon name="rocket" className="size-4" />, variant: "secondary" },
      ]}
    />
  );
}
