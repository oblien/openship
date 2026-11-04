"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useModal } from "@/context/ModalContext";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { encodeProjectSlug } from "@/utils/repoSlug";

export type ComposeChanges = { added: string[]; changed: string[]; removed: string[] };

export function ComposeChangeSummary({ changes }: { changes?: ComposeChanges }) {
  const { t } = useI18n();
  const copy = t.projects.redeploy.composeReview;
  if (!changes) return null;
  return (
    <dl className="space-y-2 text-sm">
      {(["added", "changed", "removed"] as const).map((kind) =>
        changes[kind]?.length ? (
          <div key={kind} className="flex gap-3">
            <dt className="min-w-20 shrink-0 font-medium text-foreground">{copy[kind]}</dt>
            <dd className="min-w-0 flex-1 break-words text-muted-foreground">
              {changes[kind].join(", ")}
            </dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}

/** Shared recovery for project, service, topology and build-page redeploys. */
export function useComposeReview(projectId?: string | null) {
  const { showModal, hideModal } = useModal();
  const router = useRouter();
  const { t } = useI18n();
  return useCallback(
    (error: unknown): boolean => {
      const e = error as {
        code?: string;
        body?: { code?: string; projectId?: string; composeChanges?: ComposeChanges };
      } | null;
      if ((e?.body?.code ?? e?.code) !== "COMPOSE_REVIEW_REQUIRED") return false;
      const id = projectId || e?.body?.projectId;
      if (!id) return false;
      const changes = e?.body?.composeChanges;
      const copy = t.projects.redeploy.composeReview;
      const modalId = showModal({
        title: changes?.added?.length ? copy.addedTitle : copy.title,
        customContent: (
          <div className="space-y-5 p-6">
            <h2 className="pe-8 text-lg font-semibold text-foreground">
              {changes?.added?.length ? copy.addedTitle : copy.title}
            </h2>
            <p className="text-sm text-muted-foreground">{copy.description}</p>
            <ComposeChangeSummary changes={changes} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => hideModal(modalId)}>
                {copy.cancel}
              </Button>
              <Button
                onClick={() => {
                  hideModal(modalId);
                  // Full navigation also reloads a stale review already open at this URL.
                  const url = `/deploy/${encodeProjectSlug(id)}?reviewCompose=1`;
                  if (window.location.pathname === url.split("?")[0]) window.location.assign(url);
                  else router.push(url);
                }}
              >
                {copy.configure}
              </Button>
            </div>
          </div>
        ),
        width: "520px",
        maxWidth: "92vw",
        showCloseButton: true,
      });
      return true;
    },
    [projectId, showModal, hideModal, router, t],
  );
}
