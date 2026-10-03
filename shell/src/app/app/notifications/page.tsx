import { redirect } from "next/navigation";
import NotificationList from "@/components/notify/NotificationList";
import PreferencesForm from "@/components/notify/PreferencesForm";
import { getSession } from "@/lib/auth/server";
import { currentBusiness } from "@/lib/business";
import { db } from "@/lib/db";
import { getEmailProvider, getPreferences, listNotifications } from "@/lib/notify";
import { latestBrief } from "@/lib/notify/brief";
import { parseBlocks } from "@/lib/notify/markdown";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const business = await currentBusiness(session.user.id);
  if (!business) redirect("/app/onboarding");
  const sql = db();
  const [items, prefs, brief] = await Promise.all([
    listNotifications(sql, business.id, session.user.id, { limit: 50 }),
    getPreferences(sql, business.id, session.user.id),
    latestBrief(sql, business.id),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-8">
      <h1 className="text-2xl font-semibold">Notifications</h1>

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="mb-3 font-medium">Weekly business brief</h2>
        {brief ? (
          <div className="space-y-2 text-sm">
            {parseBlocks(brief.contentMd).map((b, i) =>
              b.type === "h1" ? <h3 key={i} className="text-base font-semibold">{b.text}</h3>
              : b.type === "h2" ? <h4 key={i} className="pt-2 font-medium">{b.text}</h4>
              : b.type === "p" ? <p key={i} className="text-slate-300">{b.text}</p>
              : b.type === "ul" ? <ul key={i} className="list-disc space-y-1 pl-5 text-slate-300">{b.items.map((t, j) => <li key={j}>{t}</li>)}</ul>
              : <ol key={i} className="list-decimal space-y-1 pl-5 text-slate-300">{b.items.map((t, j) => <li key={j}>{t}</li>)}</ol>,
            )}
          </div>
        ) : (
          <p className="text-sm text-slate-400">Your first brief is written on Monday, from your real deadlines, tasks and records.</p>
        )}
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="mb-3 font-medium">Recent</h2>
        <NotificationList items={items} />
      </section>

      <section id="settings" className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="mb-3 font-medium">Notification settings</h2>
        <PreferencesForm initial={{ inApp: prefs.inApp, email: prefs.email, weeklyBrief: prefs.weeklyBrief, quietTypes: prefs.quietTypes }} emailAvailable={getEmailProvider().enabled} />
      </section>
    </div>
  );
}
