import { serverApi } from "@/lib/server/api";
import DashboardHomeClient from "./DashboardHomeClient";

export default async function DashboardHome() {
  let initialData = null;
  try {
    initialData = await serverApi.get("/api/projects/home", {
      cache: "no-store",
    });
  } catch (error) {
    console.error("Failed to fetch initial dashboard data", error);
  }

  return <DashboardHomeClient initialData={initialData} />;
}
