export const affiliateMoney = (cents: number, locale?: string) =>
  new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(cents / 100);
export const affiliateDate = (value: string | null, locale?: string) =>
  value ? new Date(value).toLocaleDateString(locale, { dateStyle: "medium" }) : "—";
/** Parse two decimal places exactly, without binary rounding or scientific notation. */
function decimalHundredths(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}
export function payoutCents(value: string): number | null {
  const cents = decimalHundredths(value);
  return cents !== null && cents >= 100 && cents <= 100000000 ? cents : null;
}
export function discountBasisPoints(value: string): number | null {
  const bps = decimalHundredths(value);
  return bps !== null && bps >= 0 && bps <= 10000 ? bps : null;
}
