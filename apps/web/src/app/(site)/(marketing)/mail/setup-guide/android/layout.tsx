import type { Metadata } from "next";
import type { ReactNode } from "react";

const TITLE = "Android Mail Setup";
const DESCRIPTION =
  "Add your Openship mailbox to the Gmail app on Android as a third-party IMAP account. Works on Android 12–15 across OEM skins.";
const PATH = "/mail/setup-guide/android";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PATH },
  openGraph: {
    title: `${TITLE} - Openship`,
    description: DESCRIPTION,
    url: PATH,
    type: "article",
    siteName: "Openship",
    locale: "en_US",
  },
  twitter: { card: "summary_large_image", title: `${TITLE} - Openship`, description: DESCRIPTION },
};

export default function Layout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
