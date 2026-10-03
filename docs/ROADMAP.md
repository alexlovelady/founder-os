# Roadmap

Phases follow docs/FounderOS_Build_Spec.md section 75. One phase at a time: plan, build, test, document.

- [x] **Phase A: Monorepo.** LegalAI moved to `modules/legal`; Railway build path updated; 189 tests pass in the new layout.
- [~] **Phase 0: Foundation (shell).** Next.js shell, auth, user/business/membership, onboarding, protected routes, module registry.
- [ ] **Phase 1: Core dashboard.** Business profile, tasks, notifications, settings.
- [ ] **Phase 2: Embed LegalAI.** Shell-issued module tokens, business-to-workspace mapping, LegalAI pages inside the shell.
- [ ] Phase 2b: Document Vault (shared across modules).
- [ ] Phases 4-9: Founder AI, Compliance, Business Health, Finance, Billing + plan-based AI tiers, hardening.

Open item: LegalAI's landmark case list is partial (CourtListener rate limits); re-run `modules/legal/scripts/resolve_cases.py` later.

Status note (2026-10-03): the shell is deployed as the main Railway service with its own Postgres. Built: sign-in (interim: LegalAI
accounts), business onboarding and profile (stored in the shell DB), dashboard combining business info with LegalAI's checklist, settings
(profile edits sync into LegalAI), LegalAI embedded same-origin over Railway's private network. Not built: roles beyond owner, team
invites, billing, plan-based AI tiers, Firebase/identity swap, other modules, custom domains.
