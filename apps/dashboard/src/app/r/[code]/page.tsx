import { ReferralLanding } from "@/components/affiliates/ReferralLanding";
export default async function ReferralPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <ReferralLanding key={code} code={code} />;
}
