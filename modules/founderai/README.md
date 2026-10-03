# founderai: Ask FounderOS

A chat assistant grounded in the real business. It reads the business profile, every tool's `describe()` summary, the attention list, and
live search results across all tools, then answers through `ctx.ai` (tier `deep`, private GPU). **v1 is read-only: it never creates or
changes data.** It is not a lawyer, accountant or financial adviser, and the UI and the system prompt both say so.

## How a question flows (all asynchronous)
1. `POST messages` saves the question, builds the prompt, starts the AI job, and saves the assistant message as `pending` with the job id.
2. The prompt = `ctx.context()` (profile + summaries, minus this tool's own line) + top attention items + numbered SOURCES `[S1]...` from
   `ctx.search()` (the full question plus up to 4 keywords, interleaved across tools, max 8) + tool pages it may suggest + the last 6 messages
   + the question. Request (system + prompt) is capped at 6000 characters; lowest-value material is trimmed first (old history, attention,
   snippets, long summaries, lowest-ranked sources), the question and profile are kept. Dropping sources from the end keeps `[S#]` stable.
3. The UI polls `GET messages/:id` every 2 s (with elapsed time). That call runs `ctx.ai.poll`; when done it post-processes and stores:
   - citations are extracted; `[S#]` that does not exist is removed; only sources actually cited are attached as `sources`;
   - numbers and dates in the answer (money, %, ISO and "March 15" dates, "N days/employees/...") that appear nowhere in the data given to
     the model produce a visible warning. It is a heuristic (coincidental matches pass, general facts like statutory deadlines are flagged):
     a "check this" notice, not a verdict;
   - links the model offered become buttons, but only `/app/t/<tool>` pages of tools that were in the context and hrefs that came from
     search hits. Anything else is dropped.
4. GPU offline shows the provider's message; AI unavailable, a failed start, a failed job or a 30-minute timeout mark the answer `failed`
   with a clear message. The question stays saved and `POST messages/:id/retry` re-runs it.

## API (`/api/tools/founderai/...`)
`GET conversations`, `GET conversations/:id`, `DELETE conversations/:id`, `POST messages {conversationId?, content}`,
`GET messages/:id`, `POST messages/:id/retry`. One unanswered question per conversation (409), 100 messages per conversation, 200 per user.

## Tables
`founderai_conversations` (business_id, user_id, title, timestamps) and `founderai_messages` (business_id, conversation_id, seq, role
`user|assistant`, content, sources jsonb, status `pending|done|failed`, ai_job_id, error, meta jsonb, created_at). `meta` holds the pending
retrieval state (candidate sources, offered tool pages, number tokens used for the warning) until the answer lands, then warnings and actions.
Messages cascade-delete with their conversation, and with the business.

## Privacy and roles
- A conversation belongs to one user within one business. Other members and other businesses get 404, and every query filters by
  `business_id` **and** `user_id`.
- Because of that, everything published from this tool (`describe`, `facts`, `search`, `resolve`) is scoped to the **current user's own**
  conversations, so titles never leak into another member's context or global search.
- **Viewers may ask** and manage their own conversations. The assistant only reads data a viewer can already see in every tool, and the rows
  it writes are the viewer's private chat history, not business data, so `requireWrite` is deliberately not used. If product policy later
  wants viewers blocked from AI usage (cost), add `requireWrite` to `POST messages` and `retry`.
- Never logs prompts or answers. Conversation content is stored in this tool's tables; users can delete it.

## Publishes
`describe()` "N conversations with the assistant; recent topics: ..."; `facts()` `{ conversationCount }`; `resolve()`/`search()` over
conversation titles; `attention()` none. All per current user.

## Deliberately not built
- No tool calling / actions: it cannot create tasks, send anything, or change records. Suggestions are plain links.
- No streaming tokens (the AI client returns a finished answer), only polling with progress.
- No token-level source verification: citations are checked for existence, not for whether the cited source really supports the claim.
- No document-body retrieval: it searches what each tool's `search()` exposes (titles/snippets), so "what do my documents say about X" is
  only as good as the documents tool's search.
- No `AskBar` component.

## Proposal: a shared actions contract (future, needs an SDK change)
Add to `ToolDef`:
```ts
actions?: {
  id: string;                       // "tasks.create"
  description: string;              // shown to the model and the user
  input: ZodType;                   // validated server side
  risk: "low" | "review";           // "review" always needs a click
  preview(ctx, input): Promise<{ summary: string }>;   // what would change, no side effects
  run(ctx, input): Promise<{ title: string; href: string }>; // does the work; calls requireWrite(ctx)
}[]
```
Flow: the assistant may only emit a JSON proposal `{action, input}` (listed in the prompt from the tools' `actions` descriptions). The server
validates it with the tool's zod schema, stores it as a `proposed` row on the message, and the UI shows the `preview` summary with Confirm /
Dismiss. Only a user click calls `run` (as that user, with their role, `requireWrite` enforced, audit-logged, idempotent by proposal id).
Viewers never see Confirm. The model never calls `run`, so a prompt injection in business data cannot change anything without a human click.

## Tests
`npx vitest run modules/founderai` (real Postgres, `FakeAi`, and a stub `fakecrm` tool defined inside the test file).
