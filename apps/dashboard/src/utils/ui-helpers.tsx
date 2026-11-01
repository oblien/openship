import { Icon as UiIcon } from "@repo/ui/icons";

export const getStatusIcon = (status: string) => {
  switch (status) {
    case "success":
    case "live":
      return <UiIcon name="check-circle" className="w-4 h-4 text-success" />;
    case "failed":
      return <UiIcon name="x-circle" className="w-4 h-4 text-danger" />;
    case "building":
    case "pending":
      return <UiIcon name="alert-circle" className="w-4 h-4 text-warning animate-pulse" />;
    case "paused":
      return <UiIcon name="clock" className="w-4 h-4 text-neutral" />;
    default:
      return <UiIcon name="clock" className="w-4 h-4 text-neutral" />;
  }
};

export const getFrameworkColor = (framework: string) => {
  const colors: { [key: string]: string } = {
    "Next.js": "bg-black dark:bg-white",
    React: "bg-blue-500",
    "Vue.js": "bg-green-500",
    "Nuxt.js": "bg-green-600",
    Astro: "bg-purple-500",
    Svelte: "bg-orange-500",
  };
  return colors[framework] || "bg-gray-500";
};
