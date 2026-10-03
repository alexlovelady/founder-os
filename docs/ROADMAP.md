# Roadmap

Phases follow docs/FounderOS_Build_Spec.md section 75. One phase at a time: plan, build, test, document.

- [x] **Phase A: Monorepo.** LegalAI moved to `modules/legal`; Railway build path updated; 189 tests pass in the new layout.
- [~] **Phase 0: Foundation (shell).** Next.js shell, auth, user/business/membership, onboarding, protected routes, module registry.
- [ ] **Phase 1: Core dashboard.** Business profile, tasks, notifications, settings.
- [ ] **Phase 2: Embed LegalAI.** Shell-issued module tokens, business-to-workspace mapping, LegalAI pages inside the shell.
- [ ] Phase 2b: Document Vault (shared across modules).
- [ ] Phases 4-9: Founder AI, Compliance, Business Health, Finance, Billing + plan-based AI tiers, hardening.

Open item: LegalAI's landmark case list is partial (CourtListener rate limits); re-run `modules/legal/scripts/resolve_cases.py` later.

Status note (2026-10-03): the shell has a module registry, landing page, sidebar layout, dashboard preview and an embedded LegalAI page
(`shell/`). Sign-in, businesses and onboarding are NOT built; they need a Firebase project (see ARCHITECTURE). LegalAI can be framed
only by origins listed in its `EMBED_ORIGINS` setting; its login cookie will not work inside a cross-site frame, so real embedding
waits for shell-issued tokens (Phase 2).
