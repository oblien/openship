import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";
import type { ReactNode } from "react";

const TITLE = "Send Mail via Code (Nodemailer / SMTP)";
const DESCRIPTION =
  "Send transactional email from your app over SMTP. A Node.js / Nodemailer example — the same credentials and fields work in any language.";
const PATH = "/mail/setup-guide/nodemailer";

const metadata: Metadata = {
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

export async function generateMetadata(
  _props: unknown,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  return inheritSocialImages(metadata, parent);
}

export default function Layout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
