"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useState } from "react";
import type { ServerCluster } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { clusterStatus } from "./model";

export function NetworkStatus({ cluster }: { cluster: ServerCluster }) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const status = clusterStatus(cluster, now);
  const Icon =
    status === "checking"
      ? "spinner"
      : status === "verified"
        ? "check-circle"
        : status === "attention" || status === "interrupted"
          ? "alert-circle"
          : "clock";
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium ${status === "verified" ? "text-success" : status === "attention" || status === "interrupted" ? "text-warning" : "text-muted-foreground"}`}
    >
      <UiIcon name={Icon} className={`size-3.5 ${status === "checking" ? "animate-spin" : ""}`} />
      {t.servers.networks.status[status]}
    </span>
  );
}
