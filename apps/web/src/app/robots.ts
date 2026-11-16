import type { MetadataRoute } from "next";

const BASE_URL = "https://openship.io";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/login", "/login/", "/dashboard/", "/admin/", "/private/", "/*/login"],
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
    host: BASE_URL,
  };
}
