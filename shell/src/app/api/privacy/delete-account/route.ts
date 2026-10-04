// Account deletion is implemented in /api/account/delete (typed email + current password). This path stays so older clients get the same behavior.
export const dynamic = "force-dynamic";
export { POST } from "@/app/api/account/delete/route";
