"use client";
import { useState, type ReactNode } from "react";

export function PricingProducts({
  cloud,
  annualCloud,
  monthsFree,
  management,
  infrastructure,
}: {
  cloud: ReactNode;
  annualCloud?: ReactNode;
  monthsFree: number;
  management: ReactNode;
  infrastructure: ReactNode;
}) {
  const [selected, setSelected] = useState("cloud");
  const [interval, setInterval] = useState(annualCloud ? "annual" : "monthly");
  return (
    <>
      <div className="pp-plan-controls">
        <div className="pp-product-tabs" role="group" aria-label="Hosting options">
          {[
            { id: "cloud", title: "Cloud plans" },
            { id: "management", title: "Manage your server" },
            { id: "infrastructure", title: "Self-hosted & dedicated" },
          ].map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={selected === option.id}
              onClick={() => setSelected(option.id)}
            >
              {option.title}
            </button>
          ))}
        </div>
        {selected === "cloud" && annualCloud && (
          <div className="pp-billing-interval" role="group" aria-label="Billing interval">
            {(["monthly", "annual"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={interval === value}
                onClick={() => setInterval(value)}
              >
                {value === "monthly" ? "Monthly" : "Yearly"}
                {value === "annual" && monthsFree > 0 && <span>{monthsFree} months free</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div hidden={selected !== "cloud" || interval !== "monthly"}>{cloud}</div>
      {annualCloud && (
        <div hidden={selected !== "cloud" || interval !== "annual"}>{annualCloud}</div>
      )}
      <div hidden={selected !== "management"}>{management}</div>
      <div hidden={selected !== "infrastructure"}>{infrastructure}</div>
    </>
  );
}
