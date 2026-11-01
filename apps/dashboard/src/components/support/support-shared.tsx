import type { CloudSupportCustomerTicket } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";

export const supportTicketHref = (id: string) => `/support?ticket=${encodeURIComponent(id)}`;

export function TicketStatus({ status }: Pick<CloudSupportCustomerTicket, "status">) {
  const { t } = useI18n();
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${
        status === "resolved" ? "bg-success-bg text-success" : "bg-info-bg text-info"
      }`}
    >
      <Icon
        name={status === "resolved" ? "check" : "clock"}
        className="size-3"
        aria-hidden="true"
      />
      {t.support.status[status]}
    </span>
  );
}

export function TicketTime({ value, full = false }: { value: string; full?: boolean }) {
  const { locale } = useI18n();
  const date = new Date(value);
  return (
    <time dateTime={value} title={date.toLocaleString(locale)}>
      {new Intl.DateTimeFormat(locale, {
        month: "short",
        day: "numeric",
        ...(full ? ({ hour: "numeric", minute: "2-digit" } as const) : {}),
      }).format(date)}
    </time>
  );
}
