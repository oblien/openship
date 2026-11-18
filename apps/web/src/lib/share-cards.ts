import type { ShareCard } from "./og-image";

// The badge is shared from repositories as well as the catalog. Every valid
// launcher link uses the same published PNG, including links with query strings.
export const deployCard = {
  title: "Deploy with",
  secondLine: "OpenShip.",
  subtitle: "Launch this project on OpenShip Cloud\nor a server you manage.",
  symbol: "deploy",
  accent: "#b5d4bf",
} satisfies ShareCard;

export const referralCard = {
  eyebrow: "Referral program",
  title: "Good tools are worth sharing.",
  subtitle: "Introduce someone to OpenShip. A small thank-you for making the connection.",
  symbol: "message",
} satisfies ShareCard;

export const sectionCards = {
  login: { title: "Sign in to OpenShip.", symbol: "trust" },
  about: {
    title: "About OpenShip.",
    subtitle: "An open source platform for deploying and running your apps.",
  },
  apps: {
    title: "Find your next app.",
    eyebrow: "App catalog",
    subtitle: "Ready-to-deploy apps for Cloud or your own servers.",
    symbol: "apps",
  },
  features: {
    title: "Inside OpenShip.",
    eyebrow: "Features",
    subtitle: "Explore the tools for deploying, running and managing your stack.",
    symbol: "layers",
  },
  compare: {
    title: "Compare platforms.",
    subtitle: "See how OpenShip compares with other ways to run your apps.",
    symbol: "layers",
  },
  mail: {
    title: "Your email.",
    secondLine: "Your control panel.",
    symbol: "mail",
    accent: "#c8cadd",
  },
  "mail/setup-guide/android": { eyebrow: "Mail setup", title: "Gmail on Android.", symbol: "mail" },
  "mail/setup-guide/ios": {
    eyebrow: "Mail setup",
    title: "Apple Mail on iOS and macOS.",
    symbol: "mail",
  },
  "mail/setup-guide/desktop": {
    eyebrow: "Mail setup",
    title: "Desktop mail clients.",
    symbol: "mail",
  },
  "mail/setup-guide/nodemailer": {
    eyebrow: "Mail setup",
    title: "Send with Nodemailer.",
    symbol: "mail",
  },
  contact: { title: "Get in touch.", eyebrow: "Contact", symbol: "message" },
  support: {
    title: "Customer support.",
    subtitle: "Get help with deployments, your account or billing.",
    symbol: "message",
  },
  trust: {
    title: "Trust and security.",
    subtitle: "How OpenShip handles data ownership and access.",
    symbol: "trust",
  },
  sla: {
    title: "Cloud uptime.",
    eyebrow: "Service level agreement",
    subtitle: "The uptime commitment for OpenShip Cloud plans.",
    symbol: "trust",
  },
  privacy: { title: "Privacy policy.", symbol: "trust" },
  terms: { title: "Terms of service.", symbol: "book" },
  blog: {
    title: "The OpenShip blog.",
    subtitle: "Stories and guides from the team.",
    symbol: "book",
  },
  changelog: {
    title: "What’s new.",
    eyebrow: "Changelog",
    subtitle: "Release notes, improvements and fixes.",
    symbol: "branch",
  },
} satisfies Record<string, ShareCard>;

export function sectionCard(key: string): ShareCard | undefined {
  return Object.hasOwn(sectionCards, key)
    ? sectionCards[key as keyof typeof sectionCards]
    : undefined;
}

/** Page metadata only references a renderable card, leaving file-based previews to Next. */
export function shareImageFor(path: string) {
  const key = path.replace(/^\//, "");
  if (key === "deploy") {
    return { url: "/og/deploy.png", width: 1200, height: 630, alt: "Deploy with OpenShip" };
  }
  const card = sectionCard(key);
  if (!card && !/^(apps|features|blog|changelog)\/[\w-]+(?:\/[\w-]+)*$/.test(key)) return;
  return {
    url: `/share/${key}`,
    width: 1200,
    height: 630,
    alt: card ? [card.title, card.secondLine].filter(Boolean).join(" ") : undefined,
  };
}
