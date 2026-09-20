"use client";

import { useCallback, useEffect, useState } from "react";
import type { ManagedNetworkOperation, ManagedNetworkPreparation } from "@repo/core";
import { useRunEvents } from "./useRunEvents";

type NetworkProgress = {
  preparation: ManagedNetworkPreparation;
  operation: ManagedNetworkOperation;
};

/** Ordered snapshots also fence late POST responses against newer SSE progress. */
export function useNetworkSetup<Kind extends keyof NetworkProgress>(
  kind: Kind,
  id: string,
  enabled: boolean,
) {
  type Progress = NetworkProgress[Kind];
  const [value, setValue] = useState<Progress | null>(null);
  const update = useCallback(
    (next: Progress) => {
      if (next.id !== id || !Number.isSafeInteger(next.sequence) || next.sequence < 1)
        throw new Error("Invalid network progress snapshot");
      setValue((previous) =>
        previous?.id === id && previous.sequence >= next.sequence ? previous : next,
      );
    },
    [id],
  );
  const stream = useRunEvents<Progress>(
    enabled
      ? `system/networks/${kind === "preparation" ? "preparations" : "operations"}/${encodeURIComponent(id)}/stream`
      : null,
    update,
  );
  const status = (stream.error as (Error & { status?: number }) | null)?.status;
  useEffect(() => {
    if (status === 401 || status === 403 || status === 404) setValue(null);
  }, [status]);
  return { progress: enabled && value?.id === id ? value : null, update, stream };
}
