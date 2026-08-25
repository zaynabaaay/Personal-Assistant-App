# Personal Assistant App

A quiet, mobile-first personal assistant interface built with Expo, React Native, TypeScript, and Expo Router.

## Run locally

```bash
npm install
npm start
```

Use `npm run ios`, `npm run android`, or `npm run web` to open a specific platform.

## OpenAI assistant

The app sends assistant requests to a server-side Vercel Function at
`api/assistant.ts`. The function calls the OpenAI Responses API; the browser never
receives the OpenAI API key.

Configure these Vercel environment variables:

- `OPENAI_API_KEY`: the project-scoped OpenAI API key
- `ALLOWED_ORIGIN`: `https://zaynabaaay.github.io`
- `SUPABASE_URL`: the Supabase project URL
- `SUPABASE_PUBLISHABLE_KEY`: the Supabase publishable key

Configure the native and web clients with:

- `EXPO_PUBLIC_SUPABASE_URL`: the same Supabase project URL
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: the same publishable key

The publishable key is designed for client use. Do not add a Supabase secret or
service-role key to this project. The assistant sends the current Supabase
access token in the `Authorization` header, and the Vercel Function verifies it
before calling OpenAI.

Build the GitHub Pages client with the public function endpoint:

```bash
EXPO_PUBLIC_ASSISTANT_API_URL=https://your-vercel-project.vercel.app/api/assistant npm run deploy
```

The production client defaults to
`https://personal-assistant-app-ten.vercel.app/api/assistant`; the environment
variable provides an override for other deployments. The public endpoint URL is
safe to include in the client. Never prefix the OpenAI API key with `EXPO_PUBLIC_`
or add it to GitHub Pages.

### Backend safeguards

The assistant function rejects request bodies larger than 48 KiB before parsing
them. Valid conversations are limited to 50 messages, 4,000 characters per
message, and 30,000 total message characters.

Production also uses a Vercel WAF rule named `Assistant API rate limit`:

- request path equals `/api/assistant`
- method equals `POST`
- fixed window of 30 requests per IP every 60 seconds
- excess requests receive HTTP 429

The WAF rule is configured in the Vercel dashboard and does not require an
additional application environment variable.

## Project persistence

The Projects domain is persisted through `SupabaseProjectRepository`. Apply the
SQL migrations in `supabase/migrations` to the same Supabase project used for
authentication before using the repository in a deployed build.

Project tables use the authenticated Supabase user as their owner. Row Level
Security compares every row's `owner_id` with `auth.uid()`; anonymous access is
revoked. Normal Project operations use the existing publishable client key and
authenticated session, never a service-role key. Meaningful domain operations
are committed with `commit_project_changes`, which writes their entity changes
and history event in one database transaction.

Tina's server-executed Project tools support bounded reads and explicit,
controlled writes. Ordinary operational requests can create or update Project
records, while replacing accepted knowledge or an active decision requires a
confirmed replacement. The Project service suppresses obvious exact duplicates
and preserves superseded records through the existing atomic domain operations.

## Conversation History

Home conversations are durable unfinished drafts. Each sent user message and
assistant reply is appended promptly through an authenticated, idempotent RPC;
the owner has at most one active draft, and the app restores its ordered messages
and original timestamps after sign-in or restart. A small owner-scoped local
outbox preserves a message when a network response is interrupted so saving can
be retried without duplicating it.

Choosing **Finish** atomically moves that active draft and its messages into the
completed-conversation tables. The active Home transcript is cleared only after
the completed transcript is read back and verified. A fresh empty draft remains
in memory and is created in storage lazily when its first message is sent.

Completed conversations are available from the minimal History route. RLS limits
both `completed_conversations` and `conversation_messages` to `auth.uid()`, and
the completion RPC derives ownership from that verified identity rather than a
client-provided user ID. The conversation ID is the idempotency key: an exact
retry succeeds without duplicate rows, while reuse with a different transcript
is rejected. A deterministic date/time title and message-count summary are used
when generated metadata is unavailable.

Authenticated assistant recall uses a read-only, owner-scoped full-text search
over completed messages. The server expands a small set of common related terms,
then PostgreSQL ranks matches and returns at most four conversations with three
nearby, bounded message excerpts each. Search results remain historical evidence;
they are never promoted automatically into current Project truth.

After the completed transcript is safe, the client calls the authenticated
`/api/process-conversation` function. This second lifecycle matches bounded
message segments only to existing Projects, retrieves each matched Project's
current truth, and stores one summary-only work session per Project. Unrelated
segments and raw transcript entries are not copied into Project storage.

The processing plan is saved once. Each matched Project has its own checkpoint,
and its Project changes, pending candidates, and checkpoint completion are
committed in one transaction with deterministic IDs. A retry skips completed
Project checkpoints and safely resumes failed ones. Potential changes expressed
as brainstorming or ambiguous language can be retained as lightweight pending
candidates without changing current Project truth.

## General memory

General memory is a small structured layer beside raw History and explicit
Projects. `general_memories` stores owner-scoped durable memory (preferences,
goals, constraints, and useful background) and changing current-state memory
(temporary facts, plans, commitments, and inventory-like state). It does not
write Project tables and does not replace the original conversation evidence.

Each durably saved user message starts bounded memory extraction in parallel
with the assistant response. Processing reads only that message, up to six
nearby turns, and at most twelve relevant existing memories. Restore and Finish
retry interrupted processing; an owner/message checkpoint makes retries
idempotent and avoids repeatedly analyzing the whole transcript. Finish remains
safe if memory processing is temporarily unavailable.

The analyzer can promote, repeat, supersede, record a contextual exception,
coexist with compatible detail, retain an ambiguous candidate, or leave a turn
in History only. Repeated evidence refreshes an existing record. Superseded
records retain bidirectional replacement links, and every structured memory
keeps source conversation/message references. Explicit user statements and
decisions have stronger provenance than inference; inferred confidence is
capped.

Current-state records may have `valid_until` or `stale_after` timestamps when
the conversation supports them. Search computes effective `current`, `stale`,
or `expired` status at read time rather than imposing fixed expirations by
category. The assistant normally searches current structured memory directly,
uses Projects as the authority for Project-specific truth, and falls back to
the existing completed-conversation evidence search for historical recall or
when structured memory is insufficient.

Apply `20260821180000_create_general_memory.sql` after the existing conversation
migrations. Its RLS policies and RPCs derive ownership from `auth.uid()`, deny
anonymous access, and use the authenticated publishable-key client rather than
a service-role bypass.

## Deploy to GitHub Pages

```bash
npm run deploy
```

The production site is exported with the `/Personal-Assistant-App` base URL and published to the `gh-pages` branch.
