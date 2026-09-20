import { MailConsole } from "./_components/mail-console";

/**
 * /emails — the mail console, unchanged for the full platform.
 *
 * Openship Mail renders the same component at `/` (`(dashboard)/page.tsx`), so
 * this route is one of two shells over `_components/mail-console.tsx` rather than
 * the console itself.
 */
export default function EmailsPage() {
  return <MailConsole />;
}
