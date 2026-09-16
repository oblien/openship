"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Clock3, Loader2, CircleAlert } from "lucide-react";
import type { ServerCluster } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { clusterStatus } from "./model";

export function ClusterStatus({ cluster }: { cluster: ServerCluster }) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const status = clusterStatus(cluster, now);
  const Icon =
    status === "checking"
      ? Loader2
      : status === "verified"
        ? CheckCircle2
        : status === "attention" || status === "interrupted"
          ? CircleAlert
          : Clock3;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium ${status === "verified" ? "text-success" : status === "attention" || status === "interrupted" ? "text-warning" : "text-muted-foreground"}`}
    >
      <Icon className={`size-3.5 ${status === "checking" ? "animate-spin" : ""}`} />
      {t.servers.clusters.status[status]}
    </span>
  );
}
