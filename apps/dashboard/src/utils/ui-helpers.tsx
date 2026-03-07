import { AlertCircle, CheckCircle, Clock, XCircle } from "lucide-react";

export const getStatusIcon = (status: string) => {
  switch (status) {
    case "success":
    case "live":
      return <CheckCircle className="w-4 h-4 text-green-500" />;
    case "failed":
      return <XCircle className="w-4 h-4 text-red-500" />;
    case "building":
    case "pending":
      return <AlertCircle className="w-4 h-4 text-yellow-500 animate-pulse" />;
    case "paused":
      return <Clock className="w-4 h-4 text-gray-500" />;
    default:
      return <Clock className="w-4 h-4 text-gray-500" />;
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
