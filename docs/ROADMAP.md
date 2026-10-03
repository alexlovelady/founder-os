# Roadmap

Phases follow docs/FounderOS_Build_Spec.md section 75. One phase at a time: plan, build, test, document.

- [x] **Phase A: Monorepo.** LegalAI moved to `modules/legal`; Railway build path updated; 189 tests pass in the new layout.
- [~] **Phase 0: Foundation (shell).** Next.js shell, auth, user/business/membership, onboarding, protected routes, module registry.
- [ ] **Phase 1: Core dashboard.** Business profile, tasks, notifications, settings.
- [ ] **Phase 2: Embed LegalAI.** Shell-issued module tokens, business-to-workspace mapping, LegalAI pages inside the shell.
- [ ] Phase 2b: Document Vault (shared across modules).
- [ ] Phases 4-9: Founder AI, Compliance, Business Health, Finance, Billing + plan-based AI tiers, hardening.

Open item: LegalAI's landmark case list is partial (CourtListener rate limits); re-run `modules/legal/scripts/resolve_cases.py` later.

Status note (2026-10-03): all planned tools are built and deployed: Finance, Compliance, Business Health, Tasks, Document Vault, SOPs and
business documents, CRM, Marketing, Ask FounderOS (read-only assistant), Product Scan (GitHub/GitLab) and Competitor Research, plus LegalAI.
They share one business context, cross-tool links and global search (Ctrl+K). 409 tool tests pass against real Postgres.

Not yet verified end to end in a browser: AI-driven features (they run on the private GPU through LegalAI's queue), file upload in the
Vault, and the GitHub scan from the UI. Known gaps (see each tool's README): assistant cannot act yet (actions contract proposed in
modules/founderai/README.md), Vault has no text extraction or virus scanning, no email reminders, no team invites or roles beyond owner,
no billing or plan-based AI tiers, identity is still LegalAI accounts (swap via `IdentityProvider`).
Environment: set `FOUNDEROS_SECRET_KEY` (done on Railway) for stored repo tokens; `SEARCH_API_KEY` (Brave) is optional for competitor discovery.
