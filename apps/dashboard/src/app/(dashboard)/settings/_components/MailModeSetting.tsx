"use client";

/**
 * Settings → Instance → Product mode. Instance-wide default: does this box
 * present itself as Openship Mail (mail control plane in the sidebar, "OpenShip
 * Mail" in the chrome and the browser tab) or as the full platform?
 *
 * Two cards, not a toggle — the same control `ProductViewSetting` uses one tab
 * over. "Off" here isn't the absence of a feature, it's the full platform, and
 * this is the same question that page asks, just at instance scope instead of
 * per user.
 *
 * This is the DEFAULT every user gets. Anyone can still choose their own view
 * under Settings → General; that per-user cookie wins over this.
 *
 * Instance-wide state, so the API gates the write with requireInstanceAdmin()
 * (a workspace `owner` role is NOT an instance gate — see
 * apps/api/src/middleware/instance-admin.ts). We hide the card from non-owners
 * for the same reason the other instance cards do: a control that always 403s is
 * worse than no control.
 */

import { useCallback, useEffect, useState } from "react";
import { LayoutTemplate, Mail } from "lucide-react";

import { useI18n } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { usePlatform } from "@/context/PlatformContext";
import { systemApi } from "@/lib/api/system";
import { authClient, useSession } from "@/lib/auth-client";
import { readProductViewCookie, type ProductView } from "@/lib/product-view";
import { ModeChoiceCards, type ModeChoice } from "./ModeChoiceCards";
import { SettingsSection } from "./SettingsSection";

/** Same narrow cast the other instance cards use to reach the org member list. */
const orgClient = (authClient as unknown as {
  organization: {
    listMembers: () => Promise<{ data?: { members?: Array<{ userId: string; role: string }> } }>;
  };
}).organization;

export function MailModeSetting() {
  const { t } = useI18n();
  const { showToast } = useToast();
  const { selfHosted } = usePlatform();
  const { data: session } = useSession();
  const copy = t.settings.mailMode;

  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [mode, setMode] = useState<ProductView>("platform");
  /** True when nothing is stored and the env variable is what turned this on. */
  const [fromEnv, setFromEnv] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    orgClient
      .listMembers()
      .then((res) => {
        if (cancelled) return;
        const me = res.data?.members?.find((m) => m.userId === session?.user?.id);
        setIsOwner(me?.role === "owner");
      })
      .catch(() => {
        if (!cancelled) setIsOwner(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  useEffect(() => {
    if (isOwner !== true) return;
    let cancelled = false;
    systemApi
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        setMode(s.productModeEffective === "mail" ? "mail" : "platform");
        setFromEnv(!s.productMode && s.productModeEffective === "mail");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOwner]);

  const choose = useCallback(
    async (next: ProductView) => {
      const previous = mode;
      setSaving(true);
      setMode(next);
      try {
        // Explicit value both ways, never null: "platform" has to be able to
        // override an OPENSHIP_PRODUCT=mail environment, and clearing would hand
        // the decision back to it.
        await systemApi.updateSettings({ productMode: next });
        setFromEnv(false);
        // A user with their own override keeps their view — say so instead of
        // reloading into a shell that looks unchanged.
        if (readProductViewCookie()) {
          showToast(copy.savedOverridden, "success", copy.title);
        } else {
          window.location.reload();
        }
      } catch {
        setMode(previous);
        showToast(copy.errorToast, "error", copy.title);
      } finally {
        setSaving(false);
      }
    },
    [copy, mode, showToast],
  );

  // Mail is self-hosted only (the whole /api/mail mount is localOnly).
  if (!selfHosted) return null;
  if (isOwner !== true) return null;

  const choices: Array<ModeChoice<ProductView>> = [
    {
      value: "platform",
      icon: LayoutTemplate,
      label: copy.platformLabel,
      description: copy.platformDesc,
    },
    { value: "mail", icon: Mail, label: copy.mailLabel, description: copy.mailDesc },
  ];

  return (
    <SettingsSection icon={Mail} title={copy.title} description={copy.description}>
      <ModeChoiceCards
        choices={choices}
        value={mode}
        onSelect={(v) => void choose(v)}
        disabled={saving}
      />
      {fromEnv && (
        <p className="mt-4 text-[12.5px] leading-relaxed text-muted-foreground">
          {copy.envNote}
        </p>
      )}
    </SettingsSection>
  );
}
