"use client";
import { AffiliateDashboard } from "@/components/affiliates/AffiliateDashboard";
import { useResourceScope } from "@/hooks/use-scoped-resource";
export default function AffiliatesPage() {
  return <AffiliateDashboard key={useResourceScope()} />;
}
