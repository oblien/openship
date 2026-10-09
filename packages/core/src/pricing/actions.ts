import { PRICING } from "./index";

/** One USD is 60,000,000 units. A micro-USD/minute rate is therefore an
 * integer number of units/second: no floating point or per-job cent rounding. */
export const ACTIONS_UNITS_PER_CENT = 600_000;
export type ActionRunnerPrice = (typeof PRICING.actions.runners)[number];

export function actionDepositUnits(cents: number): number {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > 100_000_000)
    throw new Error("Invalid Actions deposit amount");
  return cents * ACTIONS_UNITS_PER_CENT;
}

export function actionExecutionUnits(
  rate: Pick<ActionRunnerPrice, "microUsdPerMinute">,
  seconds: number,
): number {
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < 0 ||
    seconds > 21_600 ||
    !Number.isSafeInteger(rate.microUsdPerMinute) ||
    rate.microUsdPerMinute <= 0 ||
    !Number.isSafeInteger(seconds * rate.microUsdPerMinute)
  )
    throw new Error("Invalid Actions execution charge");
  return seconds * rate.microUsdPerMinute;
}

export function actionAffordableSeconds(
  rate: Pick<ActionRunnerPrice, "microUsdPerMinute">,
  availableUnits: number,
  requestedSeconds: number,
): number {
  actionExecutionUnits(rate, requestedSeconds);
  if (!Number.isSafeInteger(availableUnits) || availableUnits < 0)
    throw new Error("Invalid Actions balance");
  return Math.min(requestedSeconds, Math.floor(availableUnits / rate.microUsdPerMinute));
}
