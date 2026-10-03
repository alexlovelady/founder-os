# Roadmap

Phases follow docs/FounderOS_Build_Spec.md section 75. One phase at a time: plan, build, test, document.

- [x] **Phase A: Monorepo.** LegalAI moved to `modules/legal`; Railway build path updated; 189 tests pass in the new layout.
- [~] **Phase 0: Foundation (shell).** Next.js shell, auth, user/business/membership, onboarding, protected routes, module registry.
- [ ] **Phase 1: Core dashboard.** Business profile, tasks, notifications, settings.
- [ ] **Phase 2: Embed LegalAI.** Shell-issued module tokens, business-to-workspace mapping, LegalAI pages inside the shell.
- [ ] Phase 2b: Document Vault (shared across modules).
- [ ] Phases 4-9: Founder AI, Compliance, Business Health, Finance, Billing + plan-based AI tiers, hardening.

Open item: LegalAI's landmark case list is partial (CourtListener rate limits); re-run `modules/legal/scripts/resolve_cases.py` later.

Status note (2026-10-03, later): everything in docs/PLAN.md "Being built now" is done and deployed: audit log, privacy export/delete, platform
admin portal, feature flags, feedback, product analytics, notifications + daily scheduler + weekly brief + system automations, plans/usage/
quotas and Stripe (inactive until keys), team invites and roles, public site with free tools and trust pages (legal pages are DRAFT),
Vault text extraction/search/classification/AI summary and hand-off to LegalAI, assistant actions with confirmation, mobile layout, CI.
740 shell/tool tests and 190 LegalAI tests pass. LegalAI landmark cases: all 24 verified.

With Stripe not configured, every business runs on the Business plan limits (so the owner is never throttled); limits switch on automatically
when STRIPE_SECRET_KEY is set. What still needs the owner is listed in docs/PLAN.md.
