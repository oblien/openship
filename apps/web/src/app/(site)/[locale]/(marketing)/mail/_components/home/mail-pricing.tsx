import { CLOUD_DASHBOARD_URL } from '@repo/core';
import { getLocale } from 'next-intl/server';
import { getCopy } from '@/i18n/copy-server';
import { getCloudPricing } from '@/lib/pricing';
import { MailPricingCards } from './mail-pricing-cards';

export async function MailPricing() {
  const { mail } = await getCloudPricing(await getLocale());
  const dashboardUrl = new URL('/emails', CLOUD_DASHBOARD_URL).href;
  if (mail) return <MailPricingCards dashboardUrl={dashboardUrl} catalog={mail} />;
  const copy = await getCopy();
  return (
    <section id="mail-pricing" className="mail-wide-section text-center">
      <h2 className="mail-heading">{copy("OpenShip Mail plans")}</h2>
      <p className="mail-intro">{copy("Current plans are temporarily unavailable.")}</p>
      <a href={dashboardUrl + '#email-plans'} className="mail-primary-link mt-4">{copy("View dashboard plans")}</a>
    </section>
  );
}
