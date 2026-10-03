# Roadmap

Phases follow docs/FounderOS_Build_Spec.md section 75. One phase at a time: plan, build, test, document.

- [x] **Phase A: Monorepo.** LegalAI moved to `modules/legal`; Railway build path updated; 189 tests pass in the new layout.
- [~] **Phase 0: Foundation (shell).** Next.js shell, auth, user/business/membership, onboarding, protected routes, module registry.
- [ ] **Phase 1: Core dashboard.** Business profile, tasks, notifications, settings.
- [ ] **Phase 2: Embed LegalAI.** Shell-issued module tokens, business-to-workspace mapping, LegalAI pages inside the shell.
- [ ] Phase 2b: Document Vault (shared across modules).
- [ ] Phases 4-9: Founder AI, Compliance, Business Health, Finance, Billing + plan-based AI tiers, hardening.

Open item: LegalAI's landmark case list is partial (CourtListener rate limits); re-run `modules/legal/scripts/resolve_cases.py` later.

Status note (2026-10-03): the shell has a module registry, landing page, sign-in (interim: LegalAI accounts), server-side route gate,
sidebar layout, dashboard, and LegalAI embedded same-origin through a proxy (`shell/`). Not built: businesses, onboarding, roles, billing,
plan-based AI tiers. Firebase is deferred; swap in via `IdentityProvider` when ready. The shell is not deployed anywhere yet; it runs
locally (`cd shell && npm run build && npm start`, with LegalAI on :8000 or `LEGAL_URL` set).
