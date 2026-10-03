import { redirect } from "next/navigation";
import AppFrame from "@/components/AppFrame";
import Bell from "@/components/notify/Bell";
import FeedbackButton from "@/components/platform/FeedbackButton";
import BusinessSwitcher from "@/components/team/BusinessSwitcher";
import { getSession } from "@/lib/auth/server";
import { currentBusiness, listBusinesses } from "@/lib/business";
import { TOOLS } from "@/lib/tools/registry";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const tools = TOOLS.map((t) => ({ id: t.id, name: t.name, group: t.group, status: t.status }));
  const [all, active] = await Promise.all([listBusinesses(session.user.id), currentBusiness(session.user.id)]);
  return (
    <AppFrame
      email={session.user.email}
      tools={tools}
      isAdmin={session.user.role === "admin"}
      topRight={<Bell />}
      switcher={all.length > 1 ? <BusinessSwitcher businesses={all.map((b) => ({ id: b.id, name: b.name, role: b.role }))} activeId={active?.id ?? all[0].id} /> : undefined}
    >
      {children}
      <FeedbackButton />
    </AppFrame>
  );
}
