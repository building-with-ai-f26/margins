# AGENTS.md — Coding Agent Operating Manual

> Give this file to your coding agent and check that it is using these instructions. Keep the stack, commands, and ground rules current.

## 1. Project Overview
- **What this repo builds:** Margins, a manuscript-review app for emerging and self-publishing fiction authors. It builds a Story Bible of characters and plotlines from the manuscript and flags possible continuity issues in a tabbed report the author approves or dismisses. It never rewrites the author's text.
- **Primary user & core workflow:** An emerging or self-publishing fiction author uploads or pastes a manuscript → saves it as a draft → AI builds a Story Bible → runs a continuity review → steps through suggestions by category (Characters, Plotlines, Timeline, Details & names), approving ✓ or dismissing ✕, with the evidence highlighted in the text. See the living PRD in `docs/index.html`.
- **Tech stack:** Plain HTML, CSS and JavaScript (no framework, no build step) · GitHub Pages for hosting · PostHog for analytics · AI: Claude, in the Claude-hosted version of the app.

## Project structure
| Path | What it is |
| --- | --- |
| `docs/index.html` | Product Page: pitch, living PRD and weekly build log (published by GitHub Pages; includes PostHog) |
| `docs/app/index.html` | The Margins app: page layout and styles (includes PostHog) |
| `docs/app/margins.js` | App logic: manuscript drafts and version history, Story Bible, AI requests, the tabbed Suggestions panel, saving |
| `docs/app/checker.js` | Free rule-based continuity checks (eye/hair colour, ages, name spellings, timeline slips) |
| `docs/*.png` | Screenshots used on the Product Page |
| `prototype/index.html` | Original Build 1 prototype, kept for reference |
| `Intent.md`, `Plan.md`, `journal/` | Planning notes |

**How it works:** the author's text is checked by the rules in `checker.js` and, where AI is available, sent to an AI model with instructions to reply with structured findings that quote the exact words. The app drops any AI finding whose quote isn't in the text, merges in the rule findings, and shows them in the Suggestions panel. Approving a finding can record the correct fact in the Story Bible. Drafts and Story Bible changes are saved with a history.

**Where AI runs:** the Claude-hosted version of the app uses Claude for the AI review and saves each author's work privately to their account. The public GitHub Pages version has no secret key (a key on a public page could be copied), so it runs the rule checks only and saves work in the browser. Next step: run the AI locally with an OpenRouter key kept in `.env` (see `.env.example`), never committed.

## 2. Commands
- **Install dependencies:** none.
- **Run locally:** open `docs/app/index.html` in a browser, or run `cd docs && python3 -m http.server 8000` and open http://localhost:8000/app/ (Product Page at http://localhost:8000/).
- **Live:** Product Page https://building-with-ai-f26.github.io/margins/ · App https://building-with-ai-f26.github.io/margins/app/
- **Run deterministic tests:** not yet (manual check: load the sample manuscript, run a continuity review, approve a finding, check History).
- **Run model evals:** not yet (Build 4).

## 3. Non-Negotiable Engineering Rules
1. **Plan before coding:** Before touching multiple files, propose a brief plan and wait for approval.
2. **Small batches:** Make small, focused changes that can be reviewed and explained by a human in a single Pull Request.
3. **Explainability:** Avoid unnecessary abstractions or dependencies. Help the human builder understand the main components, what changed, why it matters, what could break, and how it was checked.
4. **Verify changes:** Run relevant checks. For a reproducible logic bug, use a failing test to demonstrate the fix when practical. Record manual checks and known limitations; follow the selected Build 4 evaluation track.
5. **Zero secrets in code:** Never hardcode API keys, tokens, or credentials. Always read from environment variables (`.env`) and update `.env.example` when new variables are needed.
6. **Stop when looping:** If a fix fails twice in a row, stop, summarize what failed, and ask the human before trying a third approach.
