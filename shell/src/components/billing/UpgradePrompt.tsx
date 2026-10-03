"use client";
import Link from "next/link";

/**
 * Show this when a tool's API answers 402 (plan limit reached). Pass the server's own message, which already names the limit and the plan
 * that raises it. Usage: if (res.status === 402) setPrompt((await res.json()).error) ... {prompt && <UpgradePrompt message={prompt} />}
 */
export function UpgradePrompt({ message, className = "" }: { message?: string; className?: string }) {
  return (
    <div role="alert" className={`rounded-lg border border-amber-700/60 bg-amber-950/40 p-4 text-sm text-amber-100 ${className}`}>
      <p className="font-medium">You have reached a limit on your plan</p>
      <p className="mt-1 text-amber-200/90">{message || "This action needs a higher plan."}</p>
      <Link href="/app/billing" className="mt-3 inline-block rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-slate-950 hover:bg-amber-400">
        See plans
      </Link>
    </div>
  );
}

export default UpgradePrompt;
