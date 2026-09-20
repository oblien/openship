import { redirect } from "next/navigation";
import { getSession } from "@/lib/server/session";

export default async function ScaleRoute() {
  const session = await getSession();
  if (!session) redirect("/login");
  // The old sandbox has no project ownership. Production topology lives inside
  // a project/environment; old bookmarks lead to the real project picker.
  redirect("/projects");
}
