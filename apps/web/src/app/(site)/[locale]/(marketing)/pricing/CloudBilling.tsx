"use client";
import { useCopy } from "@/i18n/use-copy";

import { useState, type ReactNode } from "react";

type BillingView = {
  plans: ReactNode;
  headline: ReactNode;
  note: ReactNode;
};

export function CloudBilling({
  monthly,
  annual,
  monthsFree,
  children,
}: {
  monthly: BillingView;
  annual?: BillingView;
  monthsFree: number;
  children: ReactNode;
}) {
  const copy = useCopy();

  const [interval, setInterval] = useState<"monthly" | "annual">("monthly");
  const annualSelected = Boolean(annual) && interval === "annual";
  const selected = annualSelected && annual ? annual : monthly;
  return (
    <>
      <section className="pp-hero">
        <div className="site-container pp-hero-inner">
          <h1 className="pp-headline">
            {copy("Cloud resources for your projects.")}
            <br />
            <span aria-live="polite" aria-atomic="true">
              {selected.headline}
            </span>
          </h1>
          {selected.note && <p className="pp-hero-billing">{selected.note}</p>}
        </div>
      </section>
      <section
        id="plans"
        className="pp-plans-section"
        aria-label={copy("Plans and hosting options")}
      >
        <div className="site-container">
          <div className="pp-section-heading">
            <div>
              <h2>{copy("Cloud resource pools")}</h2>
              <p>{copy("CPU, RAM and storage shared across your projects and builds.")}</p>
            </div>
            {annual && (
              <div
                className="pp-billing-interval"
                role="group"
                aria-label={copy("Billing interval")}
              >
                {(["monthly", "annual"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={interval === value}
                    onClick={() => setInterval(value)}
                  >
                    {value === "monthly" ? copy("Monthly") : copy("Yearly")}
                    {value === "annual" && monthsFree > 0 && (
                      <span>{copy("{months} months free", { months: monthsFree })}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div hidden={annualSelected}>{monthly.plans}</div>
          {annual && <div hidden={!annualSelected}>{annual.plans}</div>}
          {children}
        </div>
      </section>
    </>
  );
}
