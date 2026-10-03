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

## Added in the second hardening pass
| Area | Control | Where / test |
|---|---|---|
| Home network exposure | **Pull mode**: the PC makes outbound HTTPS calls only; no tunnel, no public hostname, no inbound token. Requests are claimed with the node token, results are accepted only from the claiming node, and request rows (prompts, answers) are deleted as soon as they are read | `providers/pull_gpu.py`, `test_pull_gpu.py` |
| MFA | TOTP (RFC 6238) with encrypted-at-rest secrets, replay-proof codes, hashed single-use recovery codes, a signed 5-minute half-login token, rate limits, admin reset, and "sign out everywhere else". No session exists until the second factor passes | `mfa.py`, `test_mfa.py` |
| Upload scanning | Built-in: EICAR test file, executables disguised as documents, Office macros/ActiveX, zip path traversal, PDFs with launch actions, JavaScript or embedded files. Optional ClamAV via clamd (`CLAMAV_HOST`), failing closed with `CLAMAV_REQUIRED=true`. Rejections are audited | `scanning.py`, `test_scanning.py` |
| OCR | Tesseract in the server image; OCR text is flagged everywhere (`ocr_applied`, confidence, a coverage label) because verbatim checks then run against recognized text | `ingestion/ocr.py`, `test_ocr.py` |
| Backups | Daily verified backups (restore into a scratch DB + every document hash checked), retention, health check on backup age and verification, read-only token for an off-site puller that mirrors database dumps and documents to your own computer | `backup.py`, `test_backup.py` |

## Known gaps and decisions for you
* **ClamAV is optional and not deployed.** It needs roughly 1.5 GB of RAM as another Railway service, which costs real money. The
  built-in checks are always on; add ClamAV (`docs/railway.md`) before accepting uploads from people you do not trust.
* **Rate limiting is in-process** (one API instance). Move to Postgres/Redis if you scale out.
* **No application-level encryption of documents.** Railway encrypts volumes and Postgres at rest; the app adds none. MFA secrets are
  the exception (Fernet, key derived from `SESSION_SECRET`: rotating that secret invalidates enrolled authenticators).
* **Prompts transit Railway's database briefly in pull mode** (until the answer is read; stale rows are purged after a few minutes).
  Push mode avoids that but needs an inbound tunnel. Neither stores prompts in logs.
* **Sessions are not bound to a device or IP.** MFA and "sign out everywhere else" cover the common risks.
* **Audit log is append-only by convention** (no update/delete endpoints), not cryptographically chained.
* **Off-site backups run only when you schedule `scripts/pull_backup.py`** on your computer. The server-side backups live on the same
  Railway volume as the data, so they protect against mistakes and corruption but not against losing the volume.
* **LLM output is never trusted for authorization**, but a compromised model could still produce misleading *text*; the validators reduce,
  not eliminate, that risk. Treat every output as a draft for a lawyer.
