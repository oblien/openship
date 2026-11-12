import type { ReactNode } from "react";
import * as rootParams from "next/root-params";
import { hasLocale } from "next-intl";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import "@/components/marketing/marketing.css";

/** All public website pages share locale validation below their document layout. */
export default async function MarketingLayout({ children }: { children: ReactNode }) {
  if (!hasLocale(routing.locales, await rootParams.locale())) notFound();
  return children;
}
