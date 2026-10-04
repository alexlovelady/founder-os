import Link from "next/link";
import ResendForm from "@/components/account/ResendForm";
import { emailConfigured } from "@/lib/lifecycle/mail";

export const dynamic = "force-dynamic";
export const metadata = { title: "Check your email | FounderOS", robots: { index: false } };

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const { sent } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-10 text-slate-100">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-6">
        <h1 className="text-xl font-semibold">Check your email</h1>
        <p className="text-sm text-slate-300">
          {sent === "1" ? "We sent a confirmation link to the address you gave. Open it to finish creating your account. The link works once and expires in 24 hours." : "Open the confirmation link we emailed you to finish creating your account."}
        </p>
        <p className="text-xs text-slate-500">Accounts that are not confirmed within 7 days are deleted.</p>
        <ResendForm emailAvailable={emailConfigured()} />
        <p className="text-sm text-slate-400"><Link href="/login" className="underline">Back to sign in</Link></p>
      </div>
    </main>
  );
}
