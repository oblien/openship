"use client";

import { useRef, useState } from "react";
import type { CloudWorkspaceResizePreview, CloudWorkspaceSummary } from "@repo/contracts";
import { systemApi } from "@/lib/api/system";
import { getApiErrorMessage } from "@/lib/api/client";
import { randomUUID } from "@/lib/random-uuid";

export function useManagedServerActions(
  serverId: string,
  onUpdated: (row: CloudWorkspaceSummary) => void,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CloudWorkspaceResizePreview | null>(null);
  const busyRef = useRef(false);
  const resizeKey = useRef<string | null>(null);
  const deleteKey = useRef<string | null>(null);
  async function run(work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (error) {
      setError(getApiErrorMessage(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return {
    busy,
    error,
    preview,
    closePreview: () => setPreview(null),
    ensure: () => run(async () => onUpdated(await systemApi.ensureServer(serverId))),
    retry: () => run(async () => onUpdated(await systemApi.retryServerOperation(serverId))),
    previewResize: () =>
      run(async () => {
        const result = await systemApi.previewServerResize(serverId);
        resizeKey.current = randomUUID();
        setPreview(result);
      }),
    resize: () =>
      run(async () => {
        if (!preview || !resizeKey.current) return;
        onUpdated(
          await systemApi.resizeServer(serverId, {
            revision: preview.revision,
            confirmRestart: true,
            idempotencyKey: resizeKey.current,
          }),
        );
        setPreview(null);
      }),
    remove: () =>
      run(async () => {
        deleteKey.current ??= randomUUID();
        onUpdated(
          await systemApi.removeManagedServer(serverId, {
            confirmDelete: true,
            idempotencyKey: deleteKey.current,
          }),
        );
      }),
  };
}

export type ManagedServerActions = ReturnType<typeof useManagedServerActions>;
