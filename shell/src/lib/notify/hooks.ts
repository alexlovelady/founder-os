/**
 * Plan hook for the weekly brief (spec 29: a paid feature). Defaults to "everyone gets it". The shell connects billing once with
 * `setBriefEnabledHook(async (businessId) => plan.features.weeklyBrief)`; nothing else changes.
 */
type BriefHook = (businessId: string) => Promise<boolean> | boolean;
let hook: BriefHook = () => true;

export function setBriefEnabledHook(fn: BriefHook): void {
  hook = fn;
}

export async function briefEnabled(businessId: string): Promise<boolean> {
  try {
    return Boolean(await hook(businessId));
  } catch {
    return true; // a billing lookup failure must not silently stop briefs
  }
}
