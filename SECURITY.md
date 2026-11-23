# SECURITY.md · Margins security audit (Build 3)

**Live app:** https://building-with-ai-f26.github.io/margins/app/
**Security test page:** https://building-with-ai-f26.github.io/margins/app/security-test.html
**Audit date:** November 23, 2026 · **Lane:** Beginner

Margins holds unpublished manuscripts, so the main question is simple: **can anyone other than the author see or change an author's work?** This file lists what I checked, what I found, what I fixed and what's still open.

## How Margins is put together now

| Part | Where it runs | What it can see |
| --- | --- | --- |
| App pages (HTML, CSS, JavaScript) | GitHub Pages (public) | Nothing secret. Holds only the Supabase *publishable* key and the PostHog project token, which are meant to be public |
| Sign-in (email + password) | Supabase Auth | Email addresses and hashed passwords |
| Saved work: drafts, Glossary, history, reports, working copy | Supabase Postgres, table `docs` | Locked per account by row-level security |
| AI requests | Supabase Edge Function `smart-task` → OpenRouter (`openai/gpt-4o-mini`) | The text being reviewed, only while the request runs |
| OpenRouter API key | Supabase secret `OPENROUTER_API_KEY` | Never in the browser or on GitHub |
| Analytics and session replay | PostHog | Page events; replays with manuscript text and all typed input masked |

The database setup is in [`supabase/schema.sql`](supabase/schema.sql) and the AI function is in [`supabase/functions/smart-task/index.ts`](supabase/functions/smart-task/index.ts).

## What I checked, found and fixed

| # | Checked | Found | Fixed? |
| --- | --- | --- | --- |
| 1 | **Who can open an author's work** | Build 2's sign-in was email-only with no password. Anyone who typed the same email on the same device could open that work. | ✅ Replaced with Supabase email + password sign-in. The session is held by Supabase, not by a typed email. |
| 2 | **Can one account read or change another's data?** | On the public site, work was saved only in the visitor's browser (`localStorage`), so it didn't follow the author and wasn't protected by a real account. | ✅ Moved to a Supabase table with row-level security (RLS). Policies for select, insert, update and delete all require `auth.uid() = user_id`. Proven by the second-account test below. |
| 3 | **Can a signed-out visitor read the table?** | The `anon` role gets table access by default in Supabase. | ✅ `revoke all on public.docs from anon`. Signed-out reads now fail with "permission denied". |
| 4 | **Is the AI key exposed?** | A key on a public page can be copied, which is why Build 2's public site had no AI. | ✅ The key lives only in Supabase secrets and is used inside the Edge Function. It isn't in the page, the repo or `.env.example`. `.env` is git-ignored. |
| 5 | **Can strangers run up the AI bill?** | An open AI endpoint could be called by anyone, any number of times. | ✅ The function requires a signed-in user (it calls `use_ai_call()` with the caller's token, and signed-out calls get 401). It enforces 30 requests per person per day, caps prompts at 90,000 characters, and only answers requests from the Margins site and localhost. The OpenRouter key also has a $2 spending cap. |
| 6 | **Can someone change their own usage count?** | If the usage table were writable, a user could reset their limit. | ✅ `ai_usage` has RLS on and no grants for `anon` or `authenticated`. Only the `security definer` function `use_ai_call()` changes it. |
| 7 | **Secrets in code** | Searched the repo for keys. Only the Supabase publishable key (`sb_publishable_…`) and the PostHog `phc_` token appear; both are public by design. No `service_role` or secret key anywhere. | ✅ Nothing to remove. |
| 8 | **Script injection (XSS)** | Manuscript text, Glossary entries and AI output are shown on the page. | ✅ Checked: all of it goes through the app's `esc()` function before display, and AI suggestions are dropped unless their quote is found in the author's own text. |
| 9 | **Session replay recording manuscripts** | PostHog session replay could capture unpublished text. | ✅ Replays mask every input (manuscript box, password) and the manuscript view, evidence quotes and fix previews (`maskTextSelector`). Emails aren't sent to PostHog. |
| 10 | **Local server (`server.py`)** | A file-saving API could be tricked into writing outside its folder. | ✅ Paths are checked against a strict pattern and `..` is blocked; data goes to the git-ignored `margins-data/` folder. Only used when running locally. |
| 11 | **Oversized saves** | Very large saves could fill the database. | ✅ The database rejects paths over 300 characters and items over about 500 KB. The app also stops drafts at about 40,000 words. |

## The proof: second-account test

The **security test page** (`docs/app/security-test.html`) runs against the live Supabase project:

1. **Account A** signs in and saves a private note.
2. A **signed-out visitor** tries to read everyone's work and to use the AI.
3. **Account B** signs in and tries to list all work, read A's note by A's user ID, overwrite it, edit it, delete it and read the AI usage table.
4. **Account A** signs back in and checks the note is unchanged.

Expected result: Account A's own checks show **PASS** and every other attempt shows **REFUSED ✓** (for example, *"new row violates row-level security policy"* and *"permission denied for table docs"*). The screenshot of this result is submitted with Build 3.

## What's left (known risks)

- **Email addresses aren't verified.** "Confirm email" is off because Supabase's built-in email sender allows only 2 emails an hour. Someone could sign up using an address they don't own. They still can't see anyone else's work, but it means no password-reset emails yet. *Next:* add a custom email sender (for example Resend) and turn confirmation back on.
- **No password reset.** It's tied to the item above. A forgotten password currently means a new account.
- **Leaked-password protection and MFA are off.** These are Supabase settings to consider before real authors use it.
- **Manuscripts go to a third-party AI.** Text sent for review passes through OpenRouter to OpenAI. The app should say this clearly before the first review, and authors with confidential work should know.
- **Glossary entries aren't masked in session replays.** Character names and facts can appear in replays. *Next:* mask the Glossary page too, or turn replay off on private pages.
- **No automated tests in CI.** The security test is run by hand. Build 4 adds tests.
- **The 30-a-day limit is per account.** Someone could create many accounts to get more AI requests. The OpenRouter spending cap limits the damage.
- **The demo ("See how it works") saves nothing and has no AI on the live site.** That's intentional, so nothing about the demo is stored.
