# AGENTS.md — Coding Agent Operating Manual

> Give this file to your coding agent and check that it is using these instructions. Keep the stack, commands, and ground rules current.

## 1. Project Overview
- **What this repo builds:** Margins, a manuscript-review app for emerging and self-publishing fiction authors. It builds a Glossary of characters and plotlines from the manuscript and flags possible continuity issues in a tabbed report the author approves or dismisses. It never rewrites the author's text.
- **Primary user & core workflow:** An emerging or self-publishing fiction author uploads or pastes a manuscript → saves it as a draft → AI builds a Glossary → runs a continuity review → steps through suggestions by category (Characters, Plotlines, Timeline, Details & names), approving ✓ or dismissing ✕, with the evidence highlighted in the text. See the living PRD in `docs/index.html`.
- **Tech stack:** Plain HTML, CSS and JavaScript (no framework, no build step) · GitHub Pages for hosting · Supabase for sign-in (email + password), the database (Postgres with row-level security) and the AI function · OpenRouter (`openai/gpt-4o-mini`) for AI · PostHog for analytics and session replay.

## Project structure
| Path | What it is |
| --- | --- |
| `docs/index.html` | Product Page: pitch, living PRD and weekly build log (published by GitHub Pages; includes PostHog) |
| `docs/app/index.html` | The Margins app: page layout and styles (includes PostHog) |
| `docs/app/margins.js` | App logic: manuscript drafts and version history, Glossary, AI requests, the tabbed Suggestions panel, saving |
| `docs/app/security-test.html` | Security test: Account B and a signed-out visitor try to read, change and delete Account A's work; every attempt should be refused |
| `docs/app/checker.js` | Free rule-based continuity checks (eye/hair colour, ages, name spellings, timeline slips) |
| `supabase/schema.sql` | Database tables, row-level security policies and the AI usage counter (reference copy of what was run in Supabase) |
| `supabase/functions/smart-task/index.ts` | The AI function deployed in Supabase: checks sign-in, 30 requests per person per day, calls OpenRouter with the secret key |
| `SECURITY.md` | Security audit: what was checked, found, fixed and what's left |
| `server.py` | Local server: serves `docs/` at http://localhost:8000 and forwards AI requests (`POST /api/ask`) to OpenRouter using the key in `.env`. Python standard library only |
| `margins-data/` | Created when running locally: each signed-in email's drafts, Glossary, history and reports as JSON files. Private and git-ignored |
| `.env.example` | Template for `.env`; the real `.env` holds `OPENROUTER_API_KEY` and is git-ignored |
| `docs/*.png` | Screenshots used on the Product Page |
| `prototype/index.html` | Original Build 1 prototype, kept for reference |
| `Intent.md`, `Plan.md`, `journal/` | Planning notes |

**Sign-in and saving:** on the live site, authors create an account with email + password (Supabase Auth; "Confirm email" is off). Everything they save is one row in the Supabase `docs` table (`user_id`, `path`, `data`), and row-level security means each person can only read and write their own rows. In `margins.js` this is the `cloud` store mode. The Claude-hosted copy saves to the author's Claude account, and `python3 server.py` saves in `margins-data/` on that computer (both still use the older email-only sign-in). Visitors who don't want to sign in can click **See how it works**: a demo that starts with the sample manuscript, accepts their own text up to 1,000 words, has no AI on the live site, and saves nothing.

**Suggestions:** a review produces suggestions in five tabs: Grammar & punctuation, Characters, Plot, Timeline, Details & names (plus Glossary conflicts after a scan). Only real conflicts are kept: an item must quote two places in the text that disagree, or text that disagrees with the Glossary. Each conflict offers options ("Green eyes" / "Blue eyes"); choosing one applies find-and-replace fixes to the text. Grammar items offer a one-click fix. Every applied fix is logged under Recent changes with Undo, the current text auto-saves as a working copy (`working` document), and new drafts are saved only when the author clicks Update history. Scan to Add to Glossary fills the Glossary automatically; conflicting facts become Glossary conflicts, and the chosen value is written to the Glossary and the text.

**How it works:** the author's text is checked by the rules in `checker.js` and, where AI is available, sent to an AI model with instructions to reply with structured findings that quote the exact words. The app drops any AI finding whose quote isn't in the text, merges in the rule findings, and shows them in the Suggestions panel. Approving a finding can record the correct fact in the Glossary. Drafts and Glossary changes are saved with a history.

**Where AI runs:** on the live site, signed-in authors' requests go to the Supabase Edge Function `smart-task`, which checks sign-in, counts the request (30 per person per day) and calls OpenRouter with the key stored as a Supabase secret (model `openai/gpt-4o-mini`; about $0.00086 per review). Locally, `server.py` makes the call with the key from `.env`. The Claude-hosted version uses Claude. API keys never go in the page or the repo.

## 2. Commands
- **Install dependencies:** none. Needs Python 3 (on a Mac, accept the prompt to install the command line developer tools the first time).
- **Set up the API key (once):** `cp .env.example .env`, then put your OpenRouter key after `OPENROUTER_API_KEY=` in `.env`. Never commit `.env`.
- **Run locally:** `python3 server.py`, then open http://localhost:8000/app/ (Product Page at http://localhost:8000/). It should print `AI review: ON`. Press Control + C to stop. Without a key the app still runs with the rule checks only.
- **Live:** Product Page https://building-with-ai-f26.github.io/margins/ · App https://building-with-ai-f26.github.io/margins/app/
- **Run deterministic tests:** not yet (manual check: sign in, load the sample, run a review, choose an option, Undo, save a draft, check History, sign out and back in).
- **Run the security test:** open `/app/security-test.html` on the live site, enter two test accounts, click **Run security test**. Every row must say PASS or REFUSED ✓.
- **Run model evals:** not yet (Build 4).

## 3. Non-Negotiable Engineering Rules
1. **Plan before coding:** Before touching multiple files, propose a brief plan and wait for approval.
2. **Small batches:** Make small, focused changes that can be reviewed and explained by a human in a single Pull Request.
3. **Explainability:** Avoid unnecessary abstractions or dependencies. Help the human builder understand the main components, what changed, why it matters, what could break, and how it was checked.
4. **Verify changes:** Run relevant checks. For a reproducible logic bug, use a failing test to demonstrate the fix when practical. Record manual checks and known limitations; follow the selected Build 4 evaluation track.
5. **Zero secrets in code:** Never hardcode API keys, tokens, or credentials. Always read from environment variables (`.env`) and update `.env.example` when new variables are needed.
6. **Stop when looping:** If a fix fails twice in a row, stop, summarize what failed, and ask the human before trying a third approach.
7. **Check the code runs before saying it's done** *(born from a real mistake)*: in Build 3 a stray backslash (`'grammar\'`) slipped into `margins.js` and broke the whole app. After editing any `.js` file, run `node --check` on it and load the page in a browser to confirm there are no console errors.
8. **Test both sides of every hand-off together** *(born from a real mistake)*: the app saved data with paths like `accounts/<email>/meta` while `server.py` expected a different number of path parts, so saving failed only when the two ran together. When the app talks to a server, database or function, test the real round trip (save, reload, read back), not each side alone.
9. **Don't redesign what wasn't asked for** *(born from a real mistake)*: asked to add features, the agent restyled the Product Page (new fonts, columns, dark mode) away from the course template. Keep the Product Page on the template, and change visuals only when the human asks.

## 4. Shipping
- **Where it lives:** GitHub Pages publishes the `docs/` folder of the `main` branch. Product Page: https://building-with-ai-f26.github.io/margins/ · App: https://building-with-ai-f26.github.io/margins/app/ · Supabase project `gchfavopupbaacjbrcoh` (sign-in, database, `smart-task` function).
- **How to ship a change to the app or Product Page:** upload the changed files to the same folder on GitHub (Add file → Upload files), commit to `main` with a short message, wait 1–2 minutes, then hard-refresh the live page (Cmd + Shift + R).
- **How to ship a database change:** paste the SQL into Supabase → SQL Editor → Run, then copy it into `supabase/schema.sql` so the repo matches.
- **How to ship an AI function change:** Supabase → Edge Functions → `smart-task` → Code → paste → Deploy. Keep "Verify JWT" off (the function checks sign-in itself). Copy the code into `supabase/functions/smart-task/index.ts`.
- **Secrets:** the OpenRouter key is only in Supabase → Edge Functions → Secrets (`OPENROUTER_API_KEY`) and in the local, git-ignored `.env`. The publishable key (`sb_publishable_…`) and the PostHog `phc_` token are public and may be in the page.
- **After every ship, check on the live site (and once from a phone):** sign in, review the sample, reload and see the work is still there, run the security test page, and confirm PostHog shows the new events and a session replay.
- **Rollback:** on GitHub, open the file → History → open the last good version → copy it back and commit. For the function, redeploy the previous code from the repo copy.

## 5. Ask me first
Stop and ask the human before you:
- Change or remove any row-level security policy, grant or revoke, or anything in `supabase/schema.sql`.
- Delete or rename tables, columns or saved user data, or run any SQL that deletes rows.
- Change Supabase sign-in settings (Confirm email, providers, password rules) or the AI daily limit.
- Add, rotate or move any API key or secret, or put any key in the page that isn't a publishable key.
- Deploy or change the `smart-task` function, or add a new paid service, model or dependency.
- Change PostHog setup or what session replay records.
- Change the look of the Product Page or app (fonts, colours, layout).
- Upload or commit anything to GitHub on the human's behalf.

