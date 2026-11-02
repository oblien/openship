"use client";

import { useId, useState } from "react";
import { AFFILIATE_PROGRAM } from "@/lib/affiliate-program";
import styles from "./affiliates.module.css";

/** An illustrative split, never a checkout quote or a saved referral setting. */
export function CommissionPreview() {
  const id = useId();
  const [discount, setDiscount] = useState(5);
  const budget = AFFILIATE_PROGRAM.commissionPercent;
  const commission = budget - discount;

  return (
    <div className={styles.splitPreview}>
      <div className={styles.splitHeading}>
        <span>A shared benefit</span>
        <span className={styles.exampleLabel}>Interactive example</span>
      </div>
      <div className={styles.splitNumbers} aria-live="polite" aria-atomic="true">
        <div>
          <p className={styles.earnValue}>
            {commission}
            <span>%</span>
          </p>
          <p className={styles.splitLabel}>Your commission</p>
        </div>
        <span className={styles.splitPlus} aria-hidden="true">
          +
        </span>
        <div>
          <p className={styles.saveValue}>
            {discount}
            <span>%</span>
          </p>
          <p className={styles.splitLabel}>Their discount</p>
        </div>
      </div>
      <div className={styles.splitBar} aria-hidden="true">
        <span style={{ width: `${(commission / budget) * 100}%` }} />
        <span style={{ width: `${(discount / budget) * 100}%` }} />
      </div>
      <label className={styles.sliderLabel} htmlFor={id}>
        Customer discount <span>{discount}%</span>
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
        aria-valuetext={`${discount}% customer discount, ${commission}% affiliate commission`}
        aria-describedby={`${id}-example`}
      />
      <div className={styles.presets} aria-label="Discount examples">
        {[0, 5, 10].map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={discount === value}
            onClick={() => setDiscount(value)}
          >
            {value === 0 ? "No discount" : `${value}% discount`}
          </button>
        ))}
      </div>
      <p className={styles.exampleCopy} id={`${id}-example`}>
        On a $100 eligible payment before discount and tax, they pay{" "}
        <strong>${100 - discount}</strong> and you earn <strong>${commission}</strong>. Actual
        earnings depend on the plan and verified payment; refunds can reduce them.
      </p>
    </div>
  );
}
