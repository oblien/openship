import type { AffiliatePayoutDestination } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { cn } from "@/lib/utils";

export const payoutMethods = ["paypal", "bank_transfer", "wise", "payoneer"] as const;
export const payoutMethodHints = {
  paypal: "paypalMethodHint",
  bank_transfer: "bankTransferHint",
  wise: "wiseMethodHint",
  payoneer: "payoneerMethodHint",
} as const;

/** Bundled provider artwork, shared by the picker, supported methods and saved accounts. */
export function PayoutMethodIcon({
  method,
  className,
}: {
  method: AffiliatePayoutDestination["method"];
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-xl",
        method === "bank_transfer" ? "bg-muted text-foreground" : "bg-white",
        className,
      )}
    >
      {method === "bank_transfer" ? (
        <Icon name="building" className="size-6" />
      ) : (
        <img
          src={`/brands/payments/${method}.${method === "payoneer" ? "png" : "svg"}`}
          alt=""
          width={28}
          height={28}
          className="size-7 object-contain"
          draggable={false}
        />
      )}
    </span>
  );
}
