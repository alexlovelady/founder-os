# Security notes (Phase 8 review)

Scope: what was checked, what is enforced where, and what is still your responsibility. This is an engineering review,
not an independent penetration test.

## Enforced in code (each has a test)
| Area | Control | Where / test |
|---|---|---|
| AuthN | argon2 password hashes, random 48-byte session tokens stored hashed, httpOnly + SameSite=Lax (+Secure in prod) cookie, 7-day expiry, constant-time-ish login (dummy hash for unknown users), login rate limit | `security.py`, `test_api.py` |
| CSRF | every state-changing request needs the per-session `X-CSRF-Token` | `test_api.py::test_bootstrap_once_and_csrf` |
| AuthZ | matter membership (viewer/editor/owner) checked on every object; 404 (not 403) for matters you cannot see; admins get **no** implicit access to matter content; the shared library is read-only for non-admins and only reachable through library/citation/document endpoints | every router has a cross-matter test |
| Privacy modes | enforced in the backend (`privacy.py`), including defense in depth inside the embedding job; a network-guard test proves a local-only matter never contacts an external host across upload, search, research, review, drafting and chat | `test_hardening.py` |
| No silent paid fallback | external LLM only if provider configured **and** matter allows it **and** budget > $0 and not exhausted; `local_only` forces it off even if the row is tampered | `test_jobs.py` |
| Uploads | extension allowlist, magic-byte checks, zip-bomb size check, size limit (streamed), sanitized names, SHA-256, safe storage keys (path traversal blocked) | `storage.py`, `test_api.py` |
| Parsers | `defusedxml` for DOCX (entity bombs rejected), HTML scripts dropped, encrypted/corrupt PDFs flagged | `test_ingestion.py` |
| Prompt injection | documents are delimited data, delimiter strings and `CITE-n` look-alikes neutralized, system prompt tells the model never to follow them, and the output is validated by code regardless | `test_research.py` |
| Hallucination | invented citation IDs removed, quotes verified verbatim, critic findings verified in code and unable to add law | `test_citations.py`, `test_critic.py`, `test_benchmarks.py` |
| SSRF | library URL sources: https only, DNS and every redirect hop checked against private/loopback/link-local/reserved ranges, 25 MB cap | `test_corpus.py` |
| GPU path | bearer token **and** HMAC signature, 60 s window, replay cache, model + parameter allowlists, body/rate limits, loopback bind | `services/gpu-gateway/tests` |
| HTTP hardening | CSP, `X-Frame-Options: DENY`, `nosniff`, no-referrer, HSTS when secure, `no-store` on API, request IDs, access logs without bodies/queries, per-IP rate limits (heavier on uploads and LLM work), request-size caps, API docs hidden outside local | `middleware.py`, `test_hardening.py` |
| Supply chain | `bandit` (no medium/high findings; one low: jitter in retry backoff), `pip-audit` (only the pip tool itself flagged), `npm audit --omit=dev` (0) | re-run before releases |

## Known gaps and decisions for you
* **Malware scanning is a stub** (`storage.scanner`). Fine for a single trusted user; add ClamAV before accepting uploads from others.
* **Rate limiting is in-process** (one API instance). Move to Postgres/Redis if you scale out.
* **Tailscale Funnel makes the gateway reachable from the internet.** It is protected by token + signature, but anyone who learns the
  token can use your GPU. Rotate `GPU_NODE_TOKEN` (Railway variable + `services/gpu-gateway/.env`) if it ever leaks. A Cloudflare Access
  service-token policy would add a second layer.
* **TLS/HSTS** rely on Railway's edge. Set `COOKIE_SECURE=true` and `TRUST_PROXY=true` in production (already done).
* **No at-rest encryption beyond the platform's.** Railway volumes and Postgres are encrypted by the provider; the app does not add
  application-level encryption of documents.
* **Sessions are not bound to a device/IP** and there is no MFA. For a single-user private system behind a strong password this is a
  reasonable trade-off; add TOTP before multi-user use.
* **Audit log is append-only by convention** (no update/delete endpoints), not cryptographically chained.
* **LLM output is never trusted for authorization**, but a compromised model could still produce misleading *text*; the validators reduce,
  not eliminate, that risk. Treat every output as a draft for a lawyer.
