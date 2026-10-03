import { redirect } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import { getSession } from "@/lib/auth/server";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSession();
  if (!user) redirect("/login");
  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar email={user.email} />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
