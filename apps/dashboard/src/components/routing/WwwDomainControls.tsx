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

interface WwwDomainControlsProps {
  endpoints: PublicEndpoint[];
  onChange: (next: PublicEndpoint[]) => void;
  allowRedirects?: boolean;
  disabled?: boolean;
}

/** The same canonical-domain choice for project and Compose service routes. */
export function WwwDomainControls(props: WwwDomainControlsProps) {
  const pairs = new Map<string, string>();
  for (const endpoint of props.endpoints) {
    const pair = getWwwDomainRouting([endpoint]);
    if (pair && !pairs.has(pair.apex)) pairs.set(pair.apex, endpoint.customDomain);
  }
  if (pairs.size === 0) return null;
  return (
    <div className="space-y-3">
      {[...pairs].map(([apex, hostname]) => (
        <WwwDomainPairControls
          key={apex}
          {...props}
          hostname={hostname}
          showHostname={pairs.size > 1}
        />
      ))}
    </div>
  );
}

function WwwDomainPairControls({
  endpoints,
  onChange,
  allowRedirects = true,
  disabled = false,
  hostname,
  showHostname,
}: WwwDomainControlsProps & { hostname: string; showHostname: boolean }) {
  const { t } = useI18n();
  const w = t.widgets.routing.publicEndpoints;
  const www = getWwwDomainRouting(endpoints, hostname);
  const label = showHostname
    ? `${t.projectSettings.domains.add.includeWww} · ${www?.apex}`
    : t.projectSettings.domains.add.includeWww;
  return (
    <fieldset className="min-w-0" disabled={disabled}>
      {www && (
        <div className="space-y-3 rounded-xl bg-muted/30 px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[13px] font-medium text-foreground">{label}</span>
            <Switch
              checked={www.included}
              onChange={(next) =>
                onChange(toggleWwwDomainRouting(endpoints, next, allowRedirects, hostname))
              }
              ariaLabel={label}
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
                    if (mode) onChange(setWwwDomainRouting(endpoints, mode, hostname));
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
                  onClick={() => onChange(setWwwDomainRouting(endpoints, "both", hostname))}
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
