"use client";

import { useId } from "react";
import type { BillingPlans } from "@repo/contracts";
import type { CustomServerResources } from "@repo/core";
import { Icon, type IconName } from "@repo/ui/icons";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type ServerResourceValues = Record<keyof CustomServerResources, string>;
export type ServerResourceRanges = NonNullable<BillingPlans["custom"]>["resources"];

export function readServerResources(
  values: ServerResourceValues,
  ranges: ServerResourceRanges,
): CustomServerResources | null {
  const resources = {
    cpuCores: Number(values.cpuCores),
    memoryMb: Number(values.memoryMb) * 1024,
    diskGb: Number(values.diskGb),
  };
  return (Object.keys(resources) as Array<keyof CustomServerResources>).every((key) => {
    const value = resources[key],
      range = ranges[key];
    return (
      values[key].trim() !== "" &&
      Number.isSafeInteger(value) &&
      value >= range.min &&
      value <= range.max &&
      value % range.step === 0
    );
  })
    ? resources
    : null;
}

/** Monthly configuration and the prepaid estimator share resource controls and validation. */
export function ServerResourceInputs({
  ranges,
  values,
  onChange,
  disabled = false,
  columns = 1,
}: {
  ranges: ServerResourceRanges;
  values: ServerResourceValues;
  onChange: (values: ServerResourceValues) => void;
  disabled?: boolean;
  columns?: 1 | 2;
}) {
  const { t } = useI18n();
  const id = useId();
  const fields: Array<{
    key: keyof CustomServerResources;
    label: string;
    unit: string;
    icon: IconName;
    divisor: number;
  }> = [
    { key: "cpuCores", label: t.billing.custom.cpu, unit: "vCPU", icon: "cpu", divisor: 1 },
    { key: "memoryMb", label: t.billing.custom.memory, unit: "GiB", icon: "memory", divisor: 1024 },
    { key: "diskGb", label: t.billing.custom.disk, unit: "GiB", icon: "hard-drive", divisor: 1 },
  ];

  return (
    <div className="@container/server-resources">
      <div
        className={cn("grid gap-5", columns === 2 && "@min-[24rem]/server-resources:grid-cols-2")}
      >
        {fields.map(({ key, label, unit, icon, divisor }) => {
          const range = ranges[key];
          const min = range.min / divisor,
            max = range.max / divisor,
            step = range.step / divisor;
          const value = Number(values[key]);
          const invalid =
            values[key].trim() === "" ||
            !Number.isFinite(value) ||
            value < min ||
            value > max ||
            !Number.isSafeInteger(value * divisor) ||
            (value * divisor) % range.step !== 0;
          return (
            <div key={key} className="@container/resource-field min-w-0">
              <div className="flex flex-col gap-2 @min-[15rem]/resource-field:flex-row @min-[15rem]/resource-field:items-center @min-[15rem]/resource-field:justify-between @min-[15rem]/resource-field:gap-3">
                <label
                  htmlFor={`${id}-${key}`}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-sm font-medium"
                >
                  <Icon
                    name={icon}
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 break-words">{label}</span>
                </label>
                <div className="relative w-full @min-[15rem]/resource-field:w-36 @min-[15rem]/resource-field:max-w-[45%] @min-[15rem]/resource-field:shrink-0">
                  <Input
                    id={`${id}-${key}`}
                    type="number"
                    variant="filled"
                    min={min}
                    max={max}
                    step={step}
                    value={values[key]}
                    disabled={disabled}
                    required
                    aria-invalid={invalid}
                    aria-describedby={`${id}-${key}-range`}
                    onChange={(event) => onChange({ ...values, [key]: event.target.value })}
                    className="pe-12 tabular-nums"
                  />
                  <span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    {unit}
                  </span>
                </div>
              </div>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={invalid ? min : value}
                aria-label={label}
                disabled={disabled}
                onChange={(event) => onChange({ ...values, [key]: event.target.value })}
                className="mt-4 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring disabled:cursor-wait [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary"
              />
              <p
                id={`${id}-${key}-range`}
                className={`mt-1 text-xs ${invalid ? "text-danger" : "text-muted-foreground"}`}
              >
                {interpolate(t.billing.custom.range, { min: String(min), max: String(max), unit })}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
