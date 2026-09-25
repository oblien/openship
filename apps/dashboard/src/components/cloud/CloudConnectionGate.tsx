"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

/**
 * CloudConnectionGate — overlay shown on cloud-bound project pages
 * when the user's Openship Cloud session is missing.
 *
 * Renders children normally when:
 *   - The project isn't cloud-bound (`deployTarget !== "cloud"`), OR
 *   - The user IS connected to Openship Cloud
 *
 * Otherwise blurs the children and overlays a CTA. Clicking the CTA
 * starts the existing connect flow (`useCloud().startConnect`) — the
 * connect-handoff endpoint now redirects through the SaaS login when
 * needed, so the user is taken to "sign in to Openship Cloud" without
 * any "No active session" errors.
 *
 * Where to mount: project layout's children wrapper. Specifically
 * `apps/dashboard/src/app/(dashboard)/projects/[id]/[[...slug]]/layout.tsx`.
 */

import { ReactNode } from "react";
import { useCloud } from "@/context/CloudContext";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface Props {
  children: ReactNode;
}

export default function CloudConnectionGate({ children }: Props) {
  const { projectData } = useProjectSettings();
  const cloud = useCloud();
  const { t } = useI18n();
  const w = t.widgets.cloud.connectionGate;

  // `deployTarget === "cloud"` IS the cloud-project signal — set by
  // backend enrichProject from `deployment.meta.deployTarget`. No
  // duplicate booleans. Combine with CloudContext.connected to decide
  // whether to gate. While cloud.loading, render children unchanged
  // — flickering a blur during the initial status check is worse
  // than briefly showing controls.
  const isCloudProject = projectData.deployTarget === "cloud";
  const blocked = isCloudProject && !cloud.loading && !cloud.connected;

  if (!blocked) return <>{children}</>;

  return (
    <div className="relative">
      <div aria-hidden className="pointer-events-none select-none blur-sm opacity-60">
        {children}
      </div>

      <div className="absolute inset-0 flex items-start justify-center pt-24 pointer-events-auto">
        <div className="max-w-md w-[90%] rounded-2xl border border-white/10 bg-neutral-950/90 backdrop-blur p-6 shadow-2xl">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-neutral-900 border border-white/10 grid place-items-center">
              <UiIcon name="cloud" className="w-5 h-5 text-neutral-300" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">{w.reconnect}</h3>
              <p className="text-xs text-neutral-400">
                {w.deployedOn}
              </p>
            </div>
          </div>

          <p className="text-sm text-neutral-300 mb-5 leading-relaxed">
            {interpolate(w.sessionMissing, { name: projectData.name || w.thisProject })}
          </p>

          <button
            type="button"
            onClick={() => cloud.startConnect()}
            disabled={cloud.connecting}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-white text-black text-sm font-medium px-4 py-2.5 hover:bg-neutral-200 disabled:opacity-60 disabled:cursor-not-allowed transition"
          >
            <UiIcon name="link" className="w-4 h-4" />
            {cloud.connecting ? w.connecting : w.connect}
          </button>

          <p className="mt-3 text-xs text-neutral-500 text-center">
            {w.readOnlyNote}
          </p>
        </div>
      </div>
    </div>
  );
}
