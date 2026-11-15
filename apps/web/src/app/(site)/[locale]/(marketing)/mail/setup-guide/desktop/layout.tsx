import { localizedMetadata } from "@/i18n/metadata";

import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";
import type { ReactNode } from "react";

const TITLE = "Desktop Mail Setup";
const DESCRIPTION =
  "Set up your OpenShip mailbox in Thunderbird, Outlook, Spark, or K-9. Standard IMAP/SMTP fields that match almost every desktop client.";
const PATH = "/mail/setup-guide/desktop";

const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PATH },
  openGraph: {
    title: `${TITLE} - OpenShip`,
    description: DESCRIPTION,
    url: PATH,
    type: "article",
    siteName: "OpenShip",
    locale: "en_US",
  },
  twitter: { card: "summary_large_image", title: `${TITLE} - OpenShip`, description: DESCRIPTION },
};

export async function generateMetadata(
  _props: unknown,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  return localizedMetadata(await inheritSocialImages(metadata, parent));
}

export default function Layout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
