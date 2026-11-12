"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import { FeatureIllustration } from "@repo/ui/illustrations";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

/** Server setup uses the same compact artwork as the infrastructure empty states. */
export function ServerEmptyState({
  onAdd,
  onAddThisMachine,
  managed = false,
}: {
  onAdd: () => void;
  managed?: boolean;
  /** Present only on a server-host with host control on — offers registering the
   *  box OpenShip runs on right from the empty state (#527). */
  onAddThisMachine?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-2xl bg-card px-6 py-10 text-center">
      <FeatureIllustration
        name={managed ? "deploy-anywhere" : "server-management"}
        className="illustration-color mx-auto mb-4 h-auto w-20"
      />

      <h3 className="mb-2 text-xl font-medium tracking-tight text-foreground">
        {managed ? t.billing.workspaces.empty : t.servers.list.emptyTitle}
      </h3>
      <p className="mx-auto mb-6 max-w-md text-sm leading-relaxed text-muted-foreground">
        {managed ? t.billing.workspaces.defaultHint : t.servers.list.emptyDescription}
      </p>

      <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
        <Button onClick={onAdd}>
          <UiIcon name="plus" className="size-4" />
          {managed ? t.billing.onboarding.choosePlan : t.servers.list.addFirstServer}
        </Button>
        {onAddThisMachine && (
          <Button variant="secondary" onClick={onAddThisMachine}>
            <UiIcon name="hard-drive" className="size-4" />
            {t.servers.list.addThisMachine}
          </Button>
        )}
        <Button asChild variant="secondary">
          <a
            href={
              managed
                ? "https://openship.io/docs/guides/cloud-workspaces"
                : "https://openship.io/docs/guides/custom-servers"
            }
            target="_blank"
            rel="noopener noreferrer"
          >
            <UiIcon name="book" className="size-4" />
            {t.servers.list.seeDocs}
            <UiIcon name="external-link" className="size-3.5 opacity-60" />
          </a>
        </Button>
      </div>
    </div>
  );
}
