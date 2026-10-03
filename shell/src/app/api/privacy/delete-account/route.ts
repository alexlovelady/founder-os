import { memberApi } from "@/lib/platform/member";

export const dynamic = "force-dynamic";

/** Accounts live in LegalAI today, so the shell cannot delete them. Say so plainly instead of pretending. */
export async function POST(req: Request) {
  const m = await memberApi(req, { write: true });
  if ("response" in m) return m.response;
  return Response.json(
    {
      error: "Account deletion is not available here yet.",
      detail:
        "Sign-in accounts are managed by LegalAI. To delete your account, contact the platform administrator (or use LegalAI settings if available). You can delete your business data here first (owner only) and export it before you do.",
    },
    { status: 501 },
  );
}
