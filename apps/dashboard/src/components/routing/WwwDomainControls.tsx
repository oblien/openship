"use client";

import { useI18n, interpolate } from "@/components/i18n-provider";
import { Switch } from "@/components/ui/Switch";
import { CustomSelect } from "@/components/ui/CustomSelect";
import type { PublicEndpoint } from "@/context/deployment/types";
import {
  getWwwDomainRouting,
  setWwwDomainRouting,
  toggleWwwDomainRouting,
  type WwwDomainMode,
} from "@/lib/www-domain-routing";

/** The same canonical-domain choice for project and Compose service routes. */
export function WwwDomainControls({
  endpoints,
  onChange,
  allowRedirects = true,
  disabled = false,
}: {
  endpoints: PublicEndpoint[];
  onChange: (next: PublicEndpoint[]) => void;
  allowRedirects?: boolean;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const w = t.widgets.routing.publicEndpoints;
  const www = getWwwDomainRouting(endpoints);
  return (
    <fieldset disabled={disabled}>
      {www && (
        <div className="space-y-3 rounded-xl bg-muted/30 px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[13px] font-medium text-foreground">
              {t.projectSettings.domains.add.includeWww}
            </span>
            <Switch
              checked={www.included}
              onChange={(next) => onChange(toggleWwwDomainRouting(endpoints, next, allowRedirects))}
              ariaLabel={t.projectSettings.domains.add.includeWww}
            />
          </div>
          {www.included && www.apex && (
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-foreground">{w.domainBehavior}</p>
              {allowRedirects ? (
                <CustomSelect<WwwDomainMode | "">
                  aria-label={w.domainBehavior}
                  variant="filled"
                  triggerClassName="bg-muted/60 hover:bg-muted"
                  value={www.mode ?? ""}
                  placeholder={w.customRouting}
                  onChange={(mode) => {
                    if (mode) onChange(setWwwDomainRouting(endpoints, mode));
                  }}
                  options={[
                    {
                      value: "apex",
                      label: interpolate(w.primaryHost, { hostname: www.apex }),
                      description: interpolate(w.redirectHostDescription, {
                        from: `www.${www.apex}`,
                        to: www.apex,
                      }),
                    },
                    {
                      value: "www",
                      label: interpolate(w.primaryHost, { hostname: `www.${www.apex}` }),
                      description: interpolate(w.redirectHostDescription, {
                        from: www.apex,
                        to: `www.${www.apex}`,
                      }),
                    },
                    { value: "both", label: w.serveBoth, description: w.serveBothDescription },
                  ]}
                />
              ) : www.mode === "both" ? (
                <p className="text-sm text-foreground">{w.serveBoth}</p>
              ) : (
                <button
                  type="button"
                  onClick={() => onChange(setWwwDomainRouting(endpoints, "both"))}
                  className="rounded-xl bg-muted px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/80"
                >
                  {w.serveBoth}
                </button>
              )}
              {!allowRedirects ? (
                <p className="text-xs text-muted-foreground">{w.serveBothDescription}</p>
              ) : (
                www.mode != null && (
                  <p className="text-xs text-muted-foreground">
                    {www.mode === "both"
                      ? w.serveBothDescription
                      : interpolate(w.redirectHostDescription, {
                          from: www.mode === "www" ? www.apex : `www.${www.apex}`,
                          to: www.mode === "www" ? `www.${www.apex}` : www.apex,
                        })}
                  </p>
                )
              )}
            </div>
          )}
        </div>
      )}
    </fieldset>
  );
}
