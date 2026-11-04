import type { AffiliateOverview } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { affiliateMoney } from "./affiliate-presentation";
import { PayoutMethodsCard } from "./PayoutMethodsCard";

export function AffiliateSidebar({
  data,
  payouts = false,
}: {
  data: AffiliateOverview;
  payouts?: boolean;
}) {
  const { t, locale } = useI18n(),
    copy = t.affiliates;
  return (
    <aside className="space-y-4">
      {payouts && <PayoutMethodsCard />}
      {data.available && (data.program.policies.length > 0 || data.member) && (
        <section className="space-y-4 rounded-2xl bg-card p-5">
          <h2 className="font-medium">{copy.programTitle}</h2>
          {data.program.policies.map((policy) => (
            <div key={policy.id} className="space-y-3 rounded-xl bg-card p-4">
              {data.program.policies.length > 1 && (
                <h3 className="text-sm font-medium">{policy.name}</h3>
              )}
              <dl className="space-y-2.5 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{copy.commissionBudget}</dt>
                  <dd className="font-medium tabular-nums">{policy.commissionBps / 100}%</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{copy.rewardDuration}</dt>
                  <dd className="shrink-0">
                    {policy.durationMonths} {copy.months}
                  </dd>
                </div>
                {!data.member && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{copy.minimum}</dt>
                    <dd>{affiliateMoney(policy.payoutMinimumCents, locale)}</dd>
                  </div>
                )}
              </dl>
            </div>
          ))}
          {data.member && (
            <dl className="flex justify-between gap-4 text-sm">
              <dt className="text-muted-foreground">{copy.minimum}</dt>
              <dd className="tabular-nums">
                {affiliateMoney(data.member.payoutMinimumCents, locale)}
              </dd>
            </dl>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">{copy.eligibility}</p>
        </section>
      )}
      {!payouts && (
        <section className="rounded-2xl bg-card p-5">
          <h2 className="font-medium">{copy.howItWorks}</h2>
          <ol className="mt-5 space-y-5">
            {[
              [copy.stepLinkTitle, copy.stepLinkHint],
              [copy.stepShareTitle, copy.stepShareHint],
              [copy.stepEarnTitle, copy.stepEarnHint],
            ].map(([title, hint], i) => (
              <li key={title} className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-muted text-xs text-muted-foreground">
                  {i + 1}
                </span>
                <div>
                  <p className="text-sm font-medium">{title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>
                </div>
              </li>
            ))}
          </ol>
          <a
            href="https://openship.io/docs/guides/affiliates"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-5 flex items-center gap-2 rounded-lg py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <Icon name="book" size="16" />
            {copy.guide}
            <Icon name="arrow-up-right" size="14" className="ms-auto" />
          </a>
        </section>
      )}
    </aside>
  );
}
