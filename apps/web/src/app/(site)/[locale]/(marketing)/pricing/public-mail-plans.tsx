"use client";

import { useState } from "react";
import { useFormatter } from "next-intl";
import { Inbox, Server, Code, Check } from "lucide-react";
import { MAIL_PRODUCTS, mailTierPrice, type MailProduct } from "@repo/core/managed-mail";
import { useCopy } from "@/i18n/use-copy";
import { cloudEmailPlanHref } from "@/lib/cloud-links";
import type { MailPricing } from "@/lib/pricing";
import { PlanCard, PlanFacts } from "./plan-card";
import { MailFeatureComparison } from "./mail-pricing-picker";

const icons = { mailboxes: Inbox, dedicated: Server, sending: Code };

export function PublicMailPlans({
  catalog,
  compare = false,
}: {
  catalog: MailPricing;
  compare?: boolean;
}) {
  const [product, select] = useState<MailProduct>("mailboxes");
  const storage = catalog.dedicatedStorage[0]!;
  const copy = useCopy();
  const format = useFormatter();
  const usd = (cents: number) =>
    format.number(cents / 100, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
  const sending = product === "sending";
  return (
    <>
      <div className="pp-mail-products" role="group" aria-label={copy("OpenShip Mail plans")}>
        {MAIL_PRODUCTS.map((id) => {
          const Icon = icons[id];
          return (
            <button type="button" key={id} aria-pressed={product === id} onClick={() => select(id)}>
              <Icon size={22} aria-hidden="true" />
              <span>
                <strong>{catalog.products[id].name}</strong>
                <small>{catalog.products[id].description}</small>
              </span>
              {id === product && <Check size={16} aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      <div className="pp-plans">
        {catalog.tiers
          .filter((tier) => tier.checkoutPlan)
          .map((tier) => (
            <PlanCard
              key={tier.id}
              name={tier.name}
              description={tier.description}
              popular={tier.popular}
              amount={usd(mailTierPrice(tier, product, storage))}
              per="/ month"
              billingNote={
                product === "dedicated" ? (
                  <>
                    {usd(storage.vmMonthlyCents)} VM · {usd(tier.sendingMonthlyCents)}{" "}
                    {catalog.products.sending.name}
                  </>
                ) : (
                  "Billed monthly"
                )
              }
              href={cloudEmailPlanHref(tier.id, product, storage.storageGB)}
              cta={copy("Choose {name}", { name: tier.name })}
              benefits={sending ? ["Send-only keys per domain"] : ["Webmail and IMAP access"]}
              support={sending ? "Track sending usage" : "Email API included"}
            >
              <PlanFacts
                checked
                facts={[
                  { label: "Monthly recipients", value: format.number(tier.recipients) },
                  { label: "Domains", value: format.number(tier.domains) },
                  ...(sending
                    ? []
                    : [
                        ...(product === "dedicated"
                          ? []
                          : [{ label: "Mailboxes", value: format.number(tier.mailboxes) }]),
                        {
                          label: "Storage",
                          value: format.number(
                            product === "dedicated" ? storage.storageGB : tier.storageMB / 1024,
                            {
                              style: "unit",
                              unit: "gigabyte",
                            },
                          ),
                        },
                      ]),
                ]}
              />
            </PlanCard>
          ))}
      </div>
      {compare && <MailFeatureComparison mode={product} includedFeatures={catalog.features} />}
    </>
  );
}
