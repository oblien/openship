// Default branding - overridable per-deploy from the openship admin panel.
// `siteConfig` stays as the build-time fallback; runtime values arrive
// via the `branding.get` tRPC query (see app/root.tsx).
//
// URLs are relative on purpose: this dist is deployed under different
// hostnames and we don't want them baked in at build time. Browsers
// resolve relative URLs against the current origin - exactly what we
// want for og:image, canonical, etc.
const TITLE = 'OpenShip Mail';
const DESCRIPTION = 'Your self-hosted mailbox.';

export const siteConfig = {
  title: TITLE,
  description: DESCRIPTION,
  icons: {
    icon: '/favicon.ico',
  },
  applicationName: 'OpenShip Mail',
  creator: 'OpenShip',
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: TITLE,
      },
    ],
  },
  category: 'Email Client',
  keywords: [
    'Mail',
    'Email',
    'Open Source',
    'Email Client',
    'Gmail Alternative',
    'Webmail',
    'Secure Email',
    'Email Management',
    'Email Platform',
    'Communication Tool',
    'Productivity',
    'Business Email',
    'Personal Email',
    'Mail Server',
    'Email Software',
    'Collaboration',
    'Message Management',
    'Digital Communication',
    'Email Service',
    'Web Application',
  ],
};
