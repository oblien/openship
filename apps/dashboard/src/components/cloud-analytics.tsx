"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useDemoMode } from "@/lib/demo-mode";
import {
  analyticsAttribution,
  analyticsScreen,
  configureCloudAnalytics,
  stopCloudAnalytics,
  trackCloudCheckoutReturn,
  trackCloudEvent,
} from "@/lib/cloud-analytics";

export function CloudAnalytics({ config }: { config: { dashboardOrigin: string } }) {
  const { user, isLoading } = useAuth();
  const demo = useDemoMode();
  const pathname = usePathname();
  const query = useSearchParams();
  const lastPage = useRef<string | null>(null);
  const lastReturn = useRef<string | null>(null);

  useEffect(() => {
    if (isLoading || demo) {
      stopCloudAnalytics();
      return;
    }
    configureCloudAnalytics(config, user?.id ?? null, demo);
    const page = `${user?.id ?? "anonymous"}:${pathname}`;
    if (lastPage.current !== page) {
      trackCloudEvent({
        event: "cloud_page_viewed",
        properties: {
          screen: analyticsScreen(pathname),
          ...analyticsAttribution(window.location.href, document.referrer),
        },
      });
      lastPage.current = page;
    }
    const returned = `${page}:${query.get("checkout")}:${query.get("topup")}`;
    if (returned !== lastReturn.current && pathname.startsWith("/billing/")) {
      trackCloudCheckoutReturn(query.toString());
      lastReturn.current = returned;
    }
    return stopCloudAnalytics;
  }, [config, user?.id, isLoading, demo, pathname, query]);

  return null;
}
