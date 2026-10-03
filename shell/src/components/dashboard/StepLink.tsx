"use client";
import { useEffect } from "react";
import Link from "next/link";
import { HEALTH_COOKIE, WELCOME_COOKIE } from "@/lib/dashboard/logic";

const YEAR = 60 * 60 * 24 * 365;
export function setFlag(name: string) {
  document.cookie = `${name}=1; path=/; max-age=${YEAR}; samesite=lax`;
}

/** A getting-started button. Steps with no fact to read from (health review) are remembered by a cookie set on click. */
export function StepLink({ href, flag, className, children }: { href: string; flag?: boolean; className?: string; children: React.ReactNode }) {
  return <Link href={href} className={className} onClick={() => { if (flag) setFlag(HEALTH_COOKIE); }}>{children}</Link>;
}

/** Marks the welcome page as seen (once shown, onboarding stops sending the person here). */
export function MarkWelcomeSeen() {
  useEffect(() => { setFlag(WELCOME_COOKIE); }, []);
  return null;
}
