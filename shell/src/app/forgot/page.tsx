import { redirect } from "next/navigation";
import ForgotForm from "@/components/account/ForgotForm";
import { getSession } from "@/lib/auth/server";
import { emailConfigured } from "@/lib/lifecycle/mail";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reset your password | FounderOS", robots: { index: false } };

export default async function ForgotPage() {
  if (await getSession()) redirect("/app/dashboard");
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-10 text-slate-100">
      <ForgotForm emailAvailable={emailConfigured()} />
    </main>
  );
}
