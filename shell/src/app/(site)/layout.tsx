import type { Metadata } from "next";
import type { ReactNode } from "react";
import SiteHeader from "@/components/site/SiteHeader";
import SiteFooter from "@/components/site/SiteFooter";
import { SITE } from "@/lib/site/config";

// The public site has its own chrome (no app sidebar). The title template and metadataBase apply to every public page.
export const metadata: Metadata = {
  metadataBase: new URL(SITE.baseUrl),
  title: { default: "FounderOS", template: "%s | FounderOS" },
  description: "Your back office for starting and running a business.",
};

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded focus:bg-slate-100 focus:px-3 focus:py-1 focus:text-slate-900">
        Skip to content
      </a>
      <SiteHeader />
      <div className="flex-1">{children}</div>
      <SiteFooter />
    </div>
  );
}
