import type { Metadata } from "next";
import { BRAND_LINKS, CLOUD_DASHBOARD_URL, SUPPORT_EMAIL } from "@repo/core";
import { ContactPage } from "@/components/marketing/contact-page";

export const metadata: Metadata = {
  title: "Support",
  description: "Get help with Openship Cloud, deployments, your account, or billing.",
  alternates: { canonical: "/support" },
};

export default function SupportPage() {
  return (
    <ContactPage
      source="support"
      eyebrow="Openship support"
      title={
        <>
          Keep moving.
          <br />
          <span>We’ll help you through.</span>
        </>
      }
      description="Get help with a deployment, your Cloud account, or billing. You can send a request here even if you can’t sign in."
      links={[
        {
          illustration: "notifications",
          title: "Your Cloud tickets",
          description: "Check your requests and continue a conversation with support.",
          href: `${CLOUD_DASHBOARD_URL}/support`,
        },
        {
          illustration: "configuration-as-code",
          title: "Find a guide",
          description: "Setup instructions, deployment guides, and API references.",
          href: BRAND_LINKS.docs,
        },
        {
          illustration: "workspaces",
          title: "Ask the community",
          description: "Share what you’re building and learn from other Openship users.",
          href: BRAND_LINKS.community,
        },
        {
          illustration: "mail",
          title: "Email support",
          description: SUPPORT_EMAIL,
          href: `mailto:${SUPPORT_EMAIL}`,
        },
      ]}
    />
  );
}
