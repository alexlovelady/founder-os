import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site/config";
import { PAGES } from "@/lib/site/pages";

export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.map((p) => ({
    url: `${SITE.baseUrl}${p.path === "/" ? "" : p.path}`,
    changeFrequency: p.changeFrequency,
    priority: p.priority,
  }));
}
