"use client";
import { ReferralDashboard } from "@/components/referrals/ReferralDashboard";
import { useResourceScope } from "@/hooks/use-scoped-resource";
export default function ReferralsPage() {
  return <ReferralDashboard key={useResourceScope()} />;
}
