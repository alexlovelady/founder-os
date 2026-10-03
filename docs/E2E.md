# End-to-end tests (Playwright)

Build spec section 66. The tests live in `e2e/`, a **standalone package** (its own `package.json` and lockfile, not an npm workspace), so installing Playwright never touches the root `package-lock.json` or the shell's dependencies. They drive a real browser against a running stack and cover the critical flows that need neither the AI nor Stripe.

## What is covered
| File | Project | What it checks |
|---|---|---|
| `tests/public.spec.ts` | `public` | Public pages render (`/`, pricing, features, security, terms, privacy, tools); sign-in page reachable and signed-out visitors are sent there; robots, sitemap, `/healthz`; the shell API refuses signed-out calls (401) and cross-site state-changing calls (403); the free calculators compute (runway 6 then 12 months, break-even 34 sales, pricing $200.00) and say nothing is saved; startup checklist tailors itself; the business health check needs every answer and then shows results |
| `tests/auth.setup.ts` | `setup` | Signs in through the real login page with the test account and saves the session |
| `tests/app-01-dashboard.spec.ts` | `app` | Onboarding creates a business **when the account has none** (otherwise it records a note and checks the dashboard); the dashboard shows the business, role, "Needs attention", "Upcoming" and the sidebar; sidebar navigation |
| `tests/app-02-tasks-crm-search.spec.ts` | `app` | Create a task (and reload), complete and reopen it, add a CRM contact, link the task to the contact from the contact page (and reload), find both with Ctrl+K, open a hit with Enter, close with Escape. Deletes what it created |
| `tests/app-03-vault.spec.ts` | `app` | Upload a small text file, open it, download it and compare the bytes, check the API download headers (attachment, nosniff); a fake PDF is refused. Deletes what it created |
| `tests/app-04-team.spec.ts` | `app` | Create an invite link, see it listed, open the invite page signed in, check that a signed-out visitor is sent to sign-in with `next=/invite/...`, revoke the link (always, even when the test fails); a made-up invite shows a clear message |
| `tests/mobile.spec.ts` | `mobile` (Pixel 7 viewport) | The sidebar becomes a slide-out menu, closes after navigating, with Escape and with the backdrop; no sideways scrolling on the main pages; the public calculators work on a phone |
| `tests/signout.spec.ts` | `signout` (runs last) | Signs in on its own, signs out, and checks that pages bounce to sign-in and the API answers 401 |

Not covered: signup (a separate flow, docs/SIGNUP.md), uploading a contract and AI review, asking Founder AI, upgrading a subscription, deleting an account. The first three need the AI; billing needs Stripe keys; account deletion is not implemented (`POST /api/privacy/delete-account` answers 501).

## Credentials
Signed-in tests need a LegalAI test account on the stack under test, passed in environment variables. **Never put real credentials in a file and never use a production account.** If `E2E_EMAIL` or `E2E_PASSWORD` is missing, those tests skip and say why; the public tests still run.

| Variable | Meaning | Default |
|---|---|---|
| `E2E_BASE_URL` | Address of the shell | `http://localhost:3000` |
| `E2E_EMAIL`, `E2E_PASSWORD` | LegalAI test account | none (signed-in tests skip) |

The tests create records tagged `e2e<random>` and delete them again (task, contact, document, invite). If a run is killed in the middle, look for leftovers with that tag. The account needs a business with the owner role for the team test; without a business the test run goes through onboarding first and creates one named `E2E Cleaning ... LLC` that stays.

## Running against a local stack
1. Postgres: `docker compose up -d db` (port 5442), and the `founderos` database (docs/DEVELOPMENT.md).
2. LegalAI on :8000 (modules/legal/README.md), with a test account (`POST /api/auth/bootstrap` for the first one).
3. The shell, built and started. **Use a production build**: the dev server compiles pages on demand and is slow and flaky for tests.
   ```
   cd shell && npm run build
   cp -r .next/static .next/standalone/shell/.next/static && cp -r public .next/standalone/shell/public
   cd .next/standalone/shell
   DATABASE_URL=postgresql://legalai:legalai-dev@localhost:5442/founderos PORT=3100 HOSTNAME=127.0.0.1 NODE_ENV=production node server.js
   ```
   (`npm start -- -p 3100` works too but warns for `output: "standalone"`.) On Windows a running server holds a lock on `.next`; stop it before rebuilding, and use a different port than the one you keep running for development.
4. Once: `cd e2e && npm install && npx playwright install chromium`.
5. Run:
   ```
   cd e2e
   E2E_BASE_URL=http://localhost:3100 E2E_EMAIL=<test account email> E2E_PASSWORD=<its password> npx playwright test
   ```
   PowerShell: `$env:E2E_BASE_URL="http://localhost:3100"; $env:E2E_EMAIL="..."; $env:E2E_PASSWORD="..."; npx playwright test`.
   Useful: `npx playwright test --project=public` (no account needed), `--headed`, `-g "vault"`, `npx playwright show-report`. Failures keep a screenshot and a trace in `e2e/test-results/` (`npx playwright show-trace <trace.zip>`).

Notes for a local stack:
* The shell's request gate (`shell/src/proxy.ts`) limits sign-ins to 10 per minute per client. A full run signs in twice (the setup project and the sign-out test); if you re-run it dozens of times in a minute you can hit 429. Without `TRUST_PROXY` every request shares one client key with a ten-times limit, so this is not a concern for normal use.
* `SCHEDULER_DISABLED=1` keeps the in-process scheduler from running during tests.
* The tests run one at a time, in order (`workers: 1`); the signed-in tests share one account.

## Running in CI
Nothing deploys from CI today (`.github/workflows/ci.yml` runs checks). To add the browser tests as a separate job you need Postgres (plain, for the shell, and pgvector for LegalAI), a built shell, a running LegalAI and a test account that CI creates itself with the bootstrap endpoint. A sketch (not added to the repository, since the workflow file is shared):
```yaml
  e2e:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env: { POSTGRES_USER: legalai, POSTGRES_PASSWORD: legalai-dev, POSTGRES_DB: legalai }
        ports: ["5442:5432"]
        options: --health-cmd "pg_isready -U legalai" --health-interval 5s --health-retries 10
    env:
      E2E_BASE_URL: http://localhost:3100
      E2E_EMAIL: ci-e2e@example.com
      E2E_PASSWORD: ${{ secrets.E2E_PASSWORD }}   # a random value that only exists for this throwaway database
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: npm ci
      - run: pip install -e modules/legal/api
      - run: PGPASSWORD=legalai-dev psql -h localhost -p 5442 -U legalai -d legalai -c "CREATE DATABASE founderos"
      - name: Start LegalAI
        working-directory: modules/legal/api
        env:
          DATABASE_URL: postgresql+psycopg://legalai:legalai-dev@localhost:5442/legalai
          SESSION_SECRET: ci-only-secret-ci-only-secret-ci-only-secret
          RUN_WORKER: "false"
        run: |
          alembic upgrade head
          nohup uvicorn legalai.main:app --port 8000 &
      - name: Create the CI test account (throwaway database)
        run: curl -fsS -X POST localhost:8000/api/auth/bootstrap -H "content-type: application/json" -d "{\"email\":\"$E2E_EMAIL\",\"password\":\"$E2E_PASSWORD\"}"
      - name: Build and start the shell
        env: { DATABASE_URL: "postgresql://legalai:legalai-dev@localhost:5442/founderos" }
        run: |
          npm run build --workspace shell
          cp -r shell/.next/static shell/.next/standalone/shell/.next/static && cp -r shell/public shell/.next/standalone/shell/public
          (cd shell && node scripts/migrate.mjs)
          (cd shell/.next/standalone/shell && PORT=3100 HOSTNAME=127.0.0.1 nohup node server.js &)
      - run: npm ci && npx playwright install --with-deps chromium
        working-directory: e2e
      - run: npx playwright test
        working-directory: e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: e2e-report, path: "e2e/test-results\ne2e/playwright-report" }
```
Adjust the details (how the CI database for the shell is created, waiting for the ports with `npx wait-on` or a curl loop) before relying on it; it was not run in CI.

## Writing more tests
* Find elements by role and label (`getByRole`, `getByLabel`), as the existing tests do; they double as an accessibility check.
* Give every record you create a `runTag()` name and remove it in `afterAll` or a `finally`. For cleanup calls made outside the browser use `sameSite` from `tests/support.ts`: the shell rejects a state-changing `/api` request that carries a session cookie but no `Origin` header (docs/OPERATIONS.md, request gate).
* Tool pages show the tool's title twice (the page shell and the tool's own header both render an `h1`), so use `.first()` when asserting a heading.
