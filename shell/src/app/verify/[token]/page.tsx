import VerifyConfirm from "@/components/account/VerifyConfirm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Confirm your email | FounderOS", robots: { index: false }, referrer: "no-referrer" };

export default async function VerifyTokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-10 text-slate-100">
      <VerifyConfirm token={token} />
    </main>
  );
}
