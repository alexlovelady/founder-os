import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site/config";

const DISALLOWED_PATHS = ["/app", "/api", "/admin", "/invite"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: DISALLOWED_PATHS }],
    sitemap: `${SITE.baseUrl}/sitemap.xml`,
  };
}
