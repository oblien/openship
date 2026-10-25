import { useI18n } from "@/components/i18n-provider";
import { PayoutMethodIcon, payoutMethods, payoutMethodHints } from "./PayoutMethodIcon";

export function PayoutMethodsCard() {
  const { t } = useI18n(),
    copy = t.affiliates;
  return (
    <section className="rounded-2xl bg-card p-5">
      <h2 className="font-medium">{copy.supportedMethods}</h2>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {copy.supportedMethodsHint}
      </p>
      <ul className="mt-5 space-y-5">
        {payoutMethods.map((method) => (
          <li key={method} className="flex items-start gap-3">
            <PayoutMethodIcon method={method} />
            <div>
              <p className="text-sm font-medium">{copy.payoutMethods[method]}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {copy[payoutMethodHints[method]]}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
