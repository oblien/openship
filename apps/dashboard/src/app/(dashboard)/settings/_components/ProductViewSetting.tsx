"use client";

/**
 * Settings → General → Interface. Per-USER choice of which control plane this
 * dashboard shows: the full platform, or Openship Mail's mail-only rail.
 *
 * Cookie-backed (see lib/product-view.ts) so the server layout resolves it during
 * SSR and the rail is right on first paint — which is also why picking one reloads
 * instead of updating local state.
 *
 * Independent of the instance-wide setting on the Instance tab: an operator on a
 * mail-branded box can pop out to the full platform (the webmail project lives in
 * /projects, and a failed webmail deploy has to be debuggable), and vice versa.
 */

import { LayoutTemplate, Mail } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { usePlatform } from "@/context/PlatformContext";
import { readProductViewCookie, type ProductView } from "@/lib/product-view";
import { ModeChoiceCards, type ModeChoice } from "./ModeChoiceCards";
import { SettingsSection } from "./SettingsSection";

export function ProductViewSetting() {
  const { t } = useI18n();
  const copy = t.settings.productView;
  const { selfHosted, productMode, productView, setProductView, clearProductView } =
    usePlatform();
  // Whether THIS browser has an explicit override, as opposed to inheriting the
  // instance default. Read after mount: SSR has no document.cookie, and rendering
  // "using the default" server-side then flipping would be worse than one tick.
  const [override, setOverride] = useState<ProductView | null>(null);
  useEffect(() => setOverride(readProductViewCookie()), []);

  // On the SaaS the mail API is local-only, so a mail rail would be dead links.
  if (!selfHosted) return null;

  const choices: Array<ModeChoice<ProductView>> = [
    {
      value: "platform",
      icon: LayoutTemplate,
      label: copy.platformLabel,
      description: copy.platformDesc,
    },
    { value: "mail", icon: Mail, label: copy.mailLabel, description: copy.mailDesc },
  ];

  const defaultLabel = productMode === "mail" ? copy.mailLabel : copy.platformLabel;

  return (
    <SettingsSection
      icon={LayoutTemplate}
      title={copy.title}
      description={copy.description}
      collapsible
    >
      <ModeChoiceCards choices={choices} value={productView} onSelect={setProductView} />

      <p className="mt-4 text-[12.5px] leading-relaxed text-muted-foreground">
        {interpolate(copy.instanceDefault, { mode: defaultLabel })}
        {override && (
          <>
            {" "}
            <button
              type="button"
              onClick={clearProductView}
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              {copy.useDefault}
            </button>
          </>
        )}
      </p>
    </SettingsSection>
  );
}
