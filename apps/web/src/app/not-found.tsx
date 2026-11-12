import { NextIntlClientProvider } from "next-intl";
import { NotFoundContent } from "@/components/not-found-content";
import messages from "@/i18n/messages/en.json";

export default function NotFound() {
  return (
    <NextIntlClientProvider locale="en" messages={{ Copy: messages.Copy }} timeZone="UTC">
      <NotFoundContent />
    </NextIntlClientProvider>
  );
}
