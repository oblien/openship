import { CLOUD_DASHBOARD_URL } from '@repo/core';
import { Link } from '@/i18n/Link';
import { useCopy } from '@/i18n/use-copy';
import { ArrowRight, GmailColor, Mail, OutlookColor, CurvedArrow } from '../icons';
import MailFooter from './footer';
import { MailAdministration, MailHosting } from './mail-administration';
import { MailAssistantPreview } from './mail-assistant-preview';
import { MailPricing } from './mail-pricing';
import { PixelatedBackground, PixelatedLeft, PixelatedRight } from './pixelated-bg';
import '../../mail.css';

const guides = [
  { title: 'iOS & macOS Mail', slug: 'ios', Icon: Mail },
  { title: 'Android Gmail app', slug: 'android', Icon: GmailColor },
  { title: 'Desktop clients', slug: 'desktop', Icon: OutlookColor },
] as const;

export default function HomeContent() {
  const copy = useCopy();
  return (
    <main data-section="dark" className="mail-home mail-page relative overflow-x-hidden bg-[#0f0f0f] px-4 text-white">
      <PixelatedBackground
        aria-hidden="true"
        className="pointer-events-none absolute -top-10 left-1/2 h-auto w-screen min-w-[1440px] -translate-x-1/2 mix-blend-screen"
        style={{ maskImage: 'linear-gradient(to bottom, black, transparent)' }}
      />
      <header className="relative mx-auto max-w-4xl pt-28 text-center md:pt-36">
        <p className="mb-4 text-sm text-[#b7b7b7]">{copy("OpenShip Mail")}</p>
        <h1 className="text-balance text-5xl font-medium tracking-tight md:text-7xl">
          {copy("Email on your own domain.")}
        </h1>
        <p className="mail-intro">
          {copy("Keep your team’s mail on your server and let OpenShip handle delivery. For a fully hosted inbox, choose OpenShip Cloud.")}
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-sm">
          <Link href="/docs/guides/email-webmail" className="mail-primary-link">
            {copy("Use my server")}
          </Link>
          <a href="#mail-pricing" className="mail-inline-link">
            {copy("View email plans")} <ArrowRight className="size-4 fill-current rtl:rotate-180" />
          </a>
        </div>
      </header>

      <figure className="mail-window">
        <PixelatedLeft aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-full hidden h-full w-auto opacity-50 mix-blend-screen lg:block" />
        <PixelatedRight aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-full hidden h-full w-auto opacity-50 mix-blend-screen lg:block" />
        <picture className="mail-inbox-preview">
          <source media="(max-width: 639px)" srcSet="/screenshots/mail-inbox-mobile.webp" width={780} height={1040} />
          <img src="/screenshots/mail-inbox.webp" width={2464} height={1360} fetchPriority="high"
            alt={copy("OpenShip Mail showing a team inbox.")} />
        </picture>
      </figure>

      <MailHosting />
      <MailAssistantPreview />
      <MailAdministration />
      <MailPricing />

      <section id="mail-clients" aria-labelledby="mail-clients-title" className="mail-section">
        <div id="setup-guides" className="scroll-mt-24">
          <h2 id="mail-clients-title" className="mail-heading">{copy("Use the mail app you already know.")}</h2>
          <p className="mail-intro">{copy("Read mail in your browser or connect Apple Mail, Gmail or Outlook with IMAP and SMTP.")}</p>
          <div className="bg-panelDark mx-auto mt-8 grid max-w-[920px] overflow-hidden rounded-2xl text-start shadow-md md:grid-cols-2">
            <div className="flex flex-col gap-1 border-b border-[#303030] p-4 md:border-b-0 md:border-e">
              <p className="px-2 pb-2 text-sm text-[#aaa]">{copy("Setup guides")}</p>
              {guides.map(({ title, slug, Icon }) => (
                <Link key={slug} href={`/mail/setup-guide/${slug}`} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-white/5">
                  <span className="grid size-9 place-items-center rounded-lg bg-[#242424]"><Icon className="size-5 fill-white" /></span>
                  {copy(title)} <ArrowRight className="ms-auto size-3.5 fill-[#999] rtl:rotate-180" />
                </Link>
              ))}
            </div>
            <div className="p-5">
              <p className="flex items-center gap-2 text-sm text-[#aaa]"><CurvedArrow className="size-4 fill-current" />{copy("Send from your code")}</p>
              <pre dir="ltr" className="my-3 overflow-x-auto rounded-lg bg-[#141414] p-3 text-xs leading-relaxed text-[#b7b7b7]"><code>{`import { OpenshipClient } from "openship/client";

const client = new OpenshipClient({
  baseUrl: "https://api.openship.io",
  token: process.env.OPENSHIP_MAIL_API_KEY,
});

await client.mail.send({
  from: "hello@example.com",
  to: ["reader@example.org"],
  subject: "Welcome",
  text: "Your inbox is ready.",
  idempotencyKey: "welcome-user-123",
});`}</code></pre>
              <div className="flex flex-wrap gap-4 text-sm">
                <Link href="/mail/setup-guide/nodemailer" className="mail-inline-link">{copy("Nodemailer")} <ArrowRight className="size-3.5 fill-current rtl:rotate-180" /></Link>
                <Link href="/docs/api/mail" className="mail-inline-link">{copy("Mail API")} <ArrowRight className="size-3.5 fill-current rtl:rotate-180" /></Link>
              </div>
            </div>
          </div>
          <a href={new URL('/apps/new/webmail', CLOUD_DASHBOARD_URL).href} className="mail-inline-link mt-5 text-sm text-[#b7b7b7]">
            {copy("Connect an existing inbox")} <ArrowRight className="size-3.5 fill-current rtl:rotate-180" />
          </a>
        </div>
      </section>

      <MailFooter />
    </main>
  );
}
