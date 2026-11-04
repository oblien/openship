"use client";

import { useId, useState } from "react";
import type { ServiceEnvironmentReview } from "@repo/contracts";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { useI18n, interpolate } from "@/components/i18n-provider";

export function SharedEnvironmentReview({
  review,
  serviceName,
  saving,
  onSave,
  onClose,
}: {
  review: ServiceEnvironmentReview;
  serviceName: string;
  saving: boolean;
  onSave: (keys: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const copy = t.projectDetail.services.detail.environmentState.shared;
  const titleId = useId();
  const [selected, setSelected] = useState(
    () => new Set(review.changes.map((change) => change.key)),
  );
  return (
    <Modal
      isOpen
      onClose={onClose}
      closable={!saving}
      showCloseButton={false}
      maxWidth="560px"
      width="94vw"
      zIndex={10020}
    >
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="space-y-4 p-6">
        <h3 id={titleId} className="text-lg font-medium">
          {copy.title}
        </h3>
        <p className="text-sm text-muted-foreground">
          {interpolate(copy.description, { name: serviceName })}
        </p>
        <div className="space-y-3">
          {review.changes.map((change, index) => (
            <label
              key={change.key}
              className="flex cursor-pointer items-start gap-3 rounded-xl bg-card p-4"
            >
              <Checkbox
                className="mt-1"
                aria-label={change.key}
                autoFocus={index === 0}
                checked={selected.has(change.key)}
                disabled={saving}
                onCheckedChange={(checked) =>
                  setSelected((previous) => {
                    const next = new Set(previous);
                    if (checked) next.add(change.key);
                    else next.delete(change.key);
                    return next;
                  })
                }
              />
              <span className="min-w-0 space-y-1">
                <code className="block break-all text-sm">{change.key}</code>
                {change.projectKey !== change.key && (
                  <span className="block text-xs text-muted-foreground">
                    {interpolate(copy.source, { key: change.projectKey })}
                  </span>
                )}
                <span className="block text-sm text-muted-foreground">
                  {change.services.map((service) => service.name).join(", ")}
                </span>
              </span>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{copy.repositoryHint}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {t.projectSettings.envVars.cancel}
          </Button>
          <Button variant="outline" disabled={saving} onClick={() => onSave([])}>
            {copy.onlyService}
          </Button>
          <Button disabled={saving || !selected.size} onClick={() => onSave([...selected])}>
            {copy.updateSelected}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
