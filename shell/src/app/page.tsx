import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-950 px-6 text-center text-slate-100">
      <h1 className="text-5xl font-semibold tracking-tight">FounderOS</h1>
      <p className="mt-4 max-w-xl text-lg text-slate-400">Your back office for starting and running a business: contracts, documents, compliance and money, in one place.</p>
      <Link href="/login" className="mt-8 rounded-lg bg-slate-100 px-5 py-2.5 font-medium text-slate-900">Sign in</Link>
      <p className="mt-10 max-w-md text-xs text-slate-500">FounderOS provides software tools and general information. It is not a law firm, an accounting firm, or a financial adviser.</p>
    </main>
  );
}
