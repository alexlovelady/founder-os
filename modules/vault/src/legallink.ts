/**
 * Where a LegalAI contract review can be opened from the vault. The LegalAI UI is proxied by the shell under /legal-ui; its route for a company
 * workspace's contracts is /matters/:id/contracts (modules/legal/web/src/App.tsx and MatterPage.tsx), and the Contracts page expands the review
 * named by `?review=<id>`. Unknown or malformed ids fall back to the LegalAI home so a bad value never lands in a URL.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function legalReviewUrl(workspaceId: string | null | undefined, reviewId?: string | null): string {
  if (!workspaceId || !UUID.test(workspaceId)) return "/legal-ui/";
  const base = `/legal-ui/matters/${workspaceId.toLowerCase()}/contracts`;
  return reviewId && UUID.test(reviewId) ? `${base}?review=${reviewId.toLowerCase()}` : base;
}
