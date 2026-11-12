"use client";
import { useCopy } from "@/i18n/use-copy";

import { useState, type ReactNode } from "react";

export function CloudBilling({
  monthly,
  annual,
  monthsFree,
}: {
  monthly: ReactNode;
  annual?: ReactNode;
  monthsFree: number;
}) {
  const copy = useCopy();

  const [interval, setInterval] = useState<"monthly" | "annual">("monthly");
  const annualSelected = Boolean(annual) && interval === "annual";
  return (
    <>
      <div className="pp-section-heading">
        <div>
          <h2>{copy("Cloud resource pools")}</h2>
          <p>{copy("CPU, RAM and storage shared across your projects and builds.")}</p>
        </div>
        {annual && (
          <div className="pp-billing-interval" role="group" aria-label={copy("Billing interval")}>
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
      <div hidden={annualSelected}>{monthly}</div>
      {annual && <div hidden={!annualSelected}>{annual}</div>}
    </>
  );
}
