import { redirect } from "next/navigation";

export default function DashboardRoot() {
  // Redirect to projects overview by default
  redirect("/projects");
}
