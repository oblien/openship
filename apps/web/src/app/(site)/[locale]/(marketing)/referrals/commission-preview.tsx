"use client";
import { useCopy } from "@/i18n/use-copy";

import { useId, useState } from "react";
import { REFERRAL_PROGRAM } from "@/lib/referral-program";
import styles from "./referrals.module.css";

/** An illustrative split, never a checkout quote or a saved referral setting. */
export function CommissionPreview() {
  const copy = useCopy();

  const id = useId();
  const [discount, setDiscount] = useState(5);
  const budget = REFERRAL_PROGRAM.commissionPercent;
  const commission = budget - discount;

  return (
    <div className={styles.splitPreview}>
      <div className={styles.splitHeading}>
        <span>{copy("A shared benefit")}</span>
        <span className={styles.exampleLabel}>{copy("Interactive example")}</span>
      </div>
      <div className={styles.splitNumbers} aria-live="polite" aria-atomic="true">
        <div>
          <p className={styles.earnValue}>
            {commission}
            <span>%</span>
          </p>
          <p className={styles.splitLabel}>{copy("Your commission")}</p>
        </div>
        <span className={styles.splitPlus} aria-hidden="true">
          +
        </span>
        <div>
          <p className={styles.saveValue}>
            {discount}
            <span>%</span>
          </p>
          <p className={styles.splitLabel}>{copy("Their discount")}</p>
        </div>
      </div>
      <div className={styles.splitBar} aria-hidden="true">
        <span style={{ width: `${(commission / budget) * 100}%` }} />
        <span style={{ width: `${(discount / budget) * 100}%` }} />
      </div>
      <label className={styles.sliderLabel} htmlFor={id}>
        {copy("Customer discount ")}
        <span>{discount}%</span>
      </label>
      <input
        className={styles.slider}
        id={id}
        type="range"
        min={0}
        max={budget}
        step={1}
        value={discount}
        onChange={(event) => setDiscount(Number(event.target.value))}
        aria-valuetext={`${discount}% customer discount, ${commission}% referral commission`}
        aria-describedby={`${id}-example`}
      />
      <div className={styles.presets} aria-label={copy("Discount examples")}>
        {[0, 5, 10].map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={discount === value}
            onClick={() => setDiscount(value)}
          >
            {value === 0
              ? copy("No discount")
              : copy("{value0}% discount", { value0: String(value) })}
          </button>
        ))}
      </div>
      <p className={styles.exampleCopy} id={`${id}-example`}>
        {copy.rich(
          "On a $100 eligible payment before discount and tax, they pay <payment>{paid}</payment> and you earn <commission>{earned}</commission>. Actual earnings depend on the plan and verified payment; refunds can reduce them.",
          {
            paid: `$${100 - discount}`,
            earned: `$${commission}`,
            payment: (children) => <strong>{children}</strong>,
            commission: (children) => <strong>{children}</strong>,
          },
        )}
      </p>
    </div>
  );
}
