"use client";

import type { RuntimeImageCheckResult } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import WarningCallout from "@/components/shared/WarningCallout";

/** Image drift reuses the existing recommendation notice and deployment action. */
export function RuntimeImageUpdateNotice({
  result,
  busy,
  onRefresh,
}: {
  result: RuntimeImageCheckResult | null;
  busy: boolean;
  onRefresh: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const copy = t.projectSettings.runtimeUpdates;
  const changed = result?.images.filter((image) => image.status === "update_available") ?? [];
  if (!changed.length) return null;
  return (
    <div role="status">
      <WarningCallout
        title={copy.available}
        description={
          <span className="space-y-1">
            {changed.map((image) => (
              <span
                key={`${image.serviceId}:${image.role}:${image.ref}`}
                className="block break-all"
              >
                <span>
                  {image.serviceName ? `${image.serviceName}: ` : ""}
                  {image.ref}
                </span>
                {image.currentDigest && image.latestDigest && (
                  <code
                    className="ms-2 text-xs"
                    dir="ltr"
                    title={`${image.currentDigest} → ${image.latestDigest}`}
                  >
                    {image.currentDigest.slice(0, 19)} → {image.latestDigest.slice(0, 19)}
                  </code>
                )}
              </span>
            ))}
          </span>
        }
        actions={
          <Button
            size="sm"
            className="h-auto min-h-8 max-w-full whitespace-normal py-2 text-start"
            disabled={busy}
            onClick={() => void onRefresh()}
          >
            {busy ? copy.refreshing : copy.refresh}
          </Button>
        }
      />
    </div>
  );
}
