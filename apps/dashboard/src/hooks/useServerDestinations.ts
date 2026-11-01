"use client";

import { useCallback, useEffect, useState } from "react";
import type { ServerOperations } from "@repo/contracts";
import { systemApi } from "@/lib/api/system";
import { getApiErrorMessage } from "@/lib/api/client";
import { useSession } from "@/lib/auth-client";
import { dockerMigrationApi } from "@/lib/api/server-migration";
import { useCloudResourceKey } from "@/context/CloudResourceContext";

export function useServerDestinations(enabled = true, inventory: "deployment" | "migration-source" = "deployment") {
  const { data: session } = useSession();
  const organizationId = session?.session.activeOrganizationId ?? undefined;
  const contextKey = `${session?.user.id ?? "local"}:${organizationId ?? ""}${inventory === "migration-source" ? ":migration-source" : ""}`;
  const cloudKey = useCloudResourceKey();
  const requestKey = `${contextKey}:${inventory === "deployment" ? cloudKey : ""}`;
  const [data, setData] = useState<Awaited<ReturnType<ServerOperations["destinations"]>> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [owner, setOwner] = useState(requestKey);
  const [loading, setLoading] = useState(enabled);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    setOwner(requestKey);
    setData(null);
    setError(null);
    setLoading(enabled);
    if (enabled)
      void (inventory === "migration-source"
        ? dockerMigrationApi.listSources().then(result => ({ servers: result.sources }))
        : systemApi.listServerDestinations())
        .then((value) => {
          if (active) setData(value);
        })
        .catch((error) => {
          if (active) setError(getApiErrorMessage(error));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    return () => {
      active = false;
    };
  }, [enabled, requestKey, revision, inventory]);
  const current = enabled && owner === requestKey;
  return {
    data: current ? data : null,
    error: current ? error : null,
    loading: enabled && (!current || loading),
    refresh,
    organizationId,
    contextKey,
    resourceKey: requestKey,
  };
}
