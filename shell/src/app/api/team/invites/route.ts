import { failure, json, readBody, sameOrigin, str } from "@/lib/team/http";
import { createInvite, listInvites } from "@/lib/team/invites";
import { teamContext } from "@/lib/team/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const t = await teamContext();
  if (!t) return json({ error: "Not signed in or no business", code: "forbidden" }, 401);
  const r = await listInvites(t.sql, t.businessId, t.session.user.id);
  return r.ok ? json({ invites: r.invites }) : failure(r);
}

/** Creates an invite. The response carries the link ONCE; only a hash is stored. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "Bad origin", code: "forbidden" }, 403);
  const t = await teamContext();
  if (!t) return json({ error: "Not signed in or no business", code: "forbidden" }, 401);
  const body = await readBody(req);
  if (!body) return json({ error: "Invalid request", code: "invalid" }, 400);
  const r = await createInvite(t.sql, {
    businessId: t.businessId,
    actorId: t.session.user.id,
    role: str(body.role),
    email: str(body.email) || null,
    expiresInDays: typeof body.expiresInDays === "number" ? body.expiresInDays : undefined,
    maxUses: typeof body.maxUses === "number" ? body.maxUses : undefined,
  });
  return r.ok ? json({ invite: r.invite, token: r.token, path: r.path }, 201) : failure(r);
}
