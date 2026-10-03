import Link from "next/link";
import { redirect } from "next/navigation";
import SignupForm from "@/components/signup/SignupForm";
import { getSession } from "@/lib/auth/server";
import { signupMode } from "@/lib/signup/config";

export const dynamic = "force-dynamic";
export const metadata = { title: "Create an account | FounderOS", robots: { index: false } };

export default async function SignupPage() {
  if (await getSession()) redirect("/app/dashboard");
  const mode = signupMode();
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-10 text-slate-100">
      {mode === "closed" ? (
        <div className="w-full max-w-sm space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-6">
          <h1 className="text-xl font-semibold">Access is by invitation</h1>
          <p className="text-sm text-slate-300">FounderOS is not open for self-service sign-up yet. If you have been given an account, sign in. Otherwise ask the person who told you about FounderOS for access.</p>
          <Link href="/login" className="inline-block rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900">Sign in</Link>
        </div>
      ) : (
        <SignupForm needsCode={mode === "invite"} />
      )}
    </main>
  );
}
