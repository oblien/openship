"use client";

import type { PlatformImportService } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";

export type ImportDomainService = Pick<PlatformImportService, "id" | "name" | "domains">;

/** Discovery and saved runs share the same public domain inventory. */
export function PlatformImportDomains({
  services,
  cutover = false,
}: {
  services: ImportDomainService[];
  cutover?: boolean;
}) {
  const { t } = useI18n();
  const copy = t.migration.platformDomains;
  const domains = services.flatMap((service) =>
    (service.domains ?? []).map((domain) => ({ ...domain, service })),
  );
  if (!cutover && !domains.length) return null;

  return (
    <section className="space-y-4 rounded-2xl bg-card p-5 sm:p-6">
      <div>
        <h3 className="font-semibold">{copy.title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{copy.intro}</p>
      </div>
      {domains.length > 0 ? (
        <ul className="divide-y divide-border/50">
          {domains.map(({ hostname, portable, service }) => (
            <li
              key={`${service.id}:${hostname}`}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <p className="break-all text-sm font-medium" dir="ltr">
                  {hostname}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{service.name}</p>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {portable ? copy.customAction : copy.providerAction}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm leading-relaxed text-muted-foreground">{copy.empty}</p>
      )}
      {!cutover && domains.some((domain) => domain.portable) && (
        <p className="text-sm leading-relaxed text-muted-foreground">{copy.customHint}</p>
      )}
      {domains.some((domain) => !domain.portable) && (
        <p className="text-sm leading-relaxed text-muted-foreground">{copy.providerHint}</p>
      )}
      {cutover && domains.length > 0 && (
        <div className="space-y-3 border-t border-border/50 pt-4">
          <h4 className="text-sm font-medium">{copy.next}</h4>
          <ol className="list-decimal space-y-2 ps-5 text-sm leading-relaxed text-muted-foreground">
            <li>{copy.test}</li>
            {domains.some((domain) => domain.portable) && <li>{copy.dns}</li>}
            <li>{copy.verify}</li>
          </ol>
        </div>
      )}
    </section>
  );
}
