"""
Margins local app server (Build 2).

What it does
  1. Serves the website in docs/ at http://localhost:8000  (the review tool is at /app/)
  2. Adds one API route, POST /api/review, that sends the excerpt to an AI model
     through OpenRouter and returns possible continuity issues.

Why a server? The OpenRouter API key must stay secret. It lives in the .env file on
your computer and is only ever read here, never sent to the browser or to GitHub.

Run it:   python3 server.py        (then open http://localhost:8000/app/)
Needs:    Python 3.9+ only. No packages to install.
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SITE_DIR = ROOT / "docs"
PORT = int(os.environ.get("PORT", "8000"))
MAX_CHARS = 20000  # keeps each run small and cheap (~3,500 words)


# ---------- settings from .env ----------

def load_env(path):
    """Read KEY=value lines from .env into os.environ (without overriding real env vars)."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env(ROOT / ".env")
API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
MODEL = os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o-mini")
API_URL = os.environ.get("OPENROUTER_URL", "https://openrouter.ai/api/v1/chat/completions")
# Used only if OpenRouter doesn't report the cost itself. Dollars per 1M tokens.
PRICE_IN = float(os.environ.get("PRICE_PER_M_INPUT", "0.15"))
PRICE_OUT = float(os.environ.get("PRICE_PER_M_OUTPUT", "0.60"))


def key_is_set():
    return bool(API_KEY) and "replace-with-your-key" not in API_KEY


# ---------- the AI call ----------

SYSTEM_PROMPT = """You are a continuity checker for fiction manuscripts.
Read the excerpt and find places where the story contradicts itself: facts about characters
(names, ages, appearance, family, relationships), places, timeline, objects, or who knows what.

Rules:
- Only report contradictions inside this excerpt. Do not comment on style, grammar, or plot quality.
- Never rewrite the author's text.
- Every finding must quote the exact words from the excerpt that conflict, copied character for character.
- If something could be intentional (flashback, dream, time passing), use confidence "check".
- If there are no contradictions, return an empty list. Do not invent problems.
- At most 8 findings.

Reply with JSON only, in this shape:
{"findings": [{"title": "short heading",
               "explanation": "one or two plain sentences",
               "confidence": "likely" or "check",
               "quotes": [{"text": "exact words from the excerpt", "label": "2-4 word label"}]}]}"""


def call_openrouter(text):
    body = {
        "model": MODEL,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "usage": {"include": True},  # ask OpenRouter to report the real cost
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": "Excerpt:\n\"\"\"\n" + text + "\n\"\"\""},
        ],
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + API_KEY,
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost",
            "X-Title": "Margins",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_findings(content):
    """Pull the JSON object out of the model's reply, even if it added extra text."""
    try:
        return json.loads(content).get("findings", [])
    except (ValueError, AttributeError):
        match = re.search(r"\{.*\}", content or "", re.S)
        if not match:
            return []
        try:
            return json.loads(match.group(0)).get("findings", [])
        except ValueError:
            return []


def locate(text, quote):
    """Find where a quote appears in the text. Returns (start, end) or None.
    Tries an exact match first, then ignores case and differences in spaces/quote marks."""
    if not quote:
        return None
    i = text.find(quote)
    if i >= 0:
        return i, i + len(quote)
    norm = lambda s: s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    words = [re.escape(w) for w in norm(quote).split()]
    if not words:
        return None
    m = re.search(r"\s+".join(words), norm(text), re.I)
    return (m.start(), m.end()) if m else None


def review(text):
    started = time.time()
    data = call_openrouter(text)
    content = data["choices"][0]["message"]["content"]
    raw = parse_findings(content)

    findings, unverified = [], 0
    for f in raw if isinstance(raw, list) else []:
        spans = []
        for q in f.get("quotes") or []:
            pos = locate(text, (q or {}).get("text", ""))
            if pos:
                spans.append({"start": pos[0], "end": pos[1], "label": str(q.get("label") or "quote")[:40]})
        # A finding whose quotes don't exist in the text is a hallucination: drop it.
        if not spans:
            unverified += 1
            continue
        findings.append({
            "rule": "ai",
            "title": str(f.get("title") or "Possible inconsistency")[:120],
            "explanation": str(f.get("explanation") or "")[:600],
            "confidence": "ai",
            "ai_confidence": "likely" if f.get("confidence") == "likely" else "check",
            "spans": spans,
        })

    usage = data.get("usage") or {}
    tin, tout = usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0)
    cost = usage.get("cost")
    if cost is None:
        cost = (tin * PRICE_IN + tout * PRICE_OUT) / 1_000_000
    return {
        "findings": findings,
        "unverified": unverified,
        "model": data.get("model", MODEL),
        "tokens_in": tin,
        "tokens_out": tout,
        "cost_usd": round(float(cost), 6),
        "seconds": round(time.time() - started, 2),
    }


# ---------- web server ----------

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE_DIR), **kwargs)

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/favicon.ico":  # no tab icon; answer quietly instead of logging an error
            self.send_response(204); self.end_headers(); return
        if self.path == "/api/health":
            return self.send_json(200, {"ok": True, "ai": key_is_set(), "model": MODEL})
        return super().do_GET()

    def do_POST(self):
        if self.path == "/api/ask":
            return self.ask()
        if self.path != "/api/review":
            return self.send_json(404, {"error": "Not found"})
        if not key_is_set():
            return self.send_json(400, {"error": "No OpenRouter key found. Add OPENROUTER_API_KEY to the .env file, then restart the server."})
        try:
            length = int(self.headers.get("Content-Length", 0))
            text = json.loads(self.rfile.read(length) or b"{}").get("text", "")
        except ValueError:
            return self.send_json(400, {"error": "Bad request."})
        if not text.strip():
            return self.send_json(400, {"error": "Paste an excerpt first."})
        if len(text) > MAX_CHARS:
            return self.send_json(413, {"error": f"Excerpt is too long for one AI review (limit {MAX_CHARS:,} characters). Try one scene at a time."})
        try:
            return self.send_json(200, review(text))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            hint = {401: "The API key was rejected. Check it in .env.",
                    402: "Your OpenRouter account is out of credits.",
                    429: "Too many requests. Wait a moment and try again."}.get(e.code, "")
            print(f"OpenRouter error {e.code}: {detail}", file=sys.stderr)
            return self.send_json(502, {"error": f"The AI service returned an error ({e.code}). {hint}".strip()})
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"Network error: {e}", file=sys.stderr)
            return self.send_json(502, {"error": "Couldn't reach the AI service. Check your internet connection."})
        except Exception as e:  # never crash the server on one bad reply
            print(f"Unexpected error: {e!r}", file=sys.stderr)
            return self.send_json(500, {"error": "Something went wrong with the AI review. See the terminal for details."})

    def ask(self):
        """Forward one prompt from the Margins app to OpenRouter and return the reply text."""
        if not key_is_set():
            return self.send_json(400, {"error": "No OpenRouter key found. Add OPENROUTER_API_KEY to the .env file, then restart the server."})
        try:
            length = int(self.headers.get("Content-Length", 0))
            prompt = json.loads(self.rfile.read(length) or b"{}").get("prompt", "")
        except ValueError:
            return self.send_json(400, {"error": "Bad request."})
        if not prompt or len(prompt) > 90000:
            return self.send_json(413, {"error": "That request is empty or too long. Try a few chapters at a time."})
        started = time.time()
        body = {"model": MODEL, "temperature": 0, "usage": {"include": True},
                "messages": [{"role": "user", "content": prompt}]}
        req = urllib.request.Request(API_URL, data=json.dumps(body).encode("utf-8"), method="POST", headers={
            "Authorization": "Bearer " + API_KEY, "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost", "X-Title": "Margins"})
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            hint = {401: "The API key was rejected. Check it in .env.", 402: "Your OpenRouter account is out of credits.",
                    429: "Too many requests. Wait a moment and try again."}.get(e.code, "")
            print(f"OpenRouter error {e.code}: {e.read().decode('utf-8', 'replace')[:300]}", file=sys.stderr)
            return self.send_json(502, {"error": f"The AI service returned an error ({e.code}). {hint}".strip()})
        except Exception as e:
            print(f"AI request failed: {e!r}", file=sys.stderr)
            return self.send_json(502, {"error": "Couldn't reach the AI service. Check your internet connection."})
        usage = data.get("usage") or {}
        tin, tout = usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0)
        cost = usage.get("cost")
        if cost is None:
            cost = (tin * PRICE_IN + tout * PRICE_OUT) / 1_000_000
        print(f"AI call: {tin}+{tout} tokens, ${float(cost):.5f}, {time.time() - started:.1f}s")
        return self.send_json(200, {"text": data["choices"][0]["message"]["content"], "model": data.get("model", MODEL),
                                    "tokens_in": tin, "tokens_out": tout, "cost_usd": round(float(cost), 6),
                                    "seconds": round(time.time() - started, 2)})

    def log_message(self, fmt, *args):
        if "/api/" in str(args[0] if args else ""):
            super().log_message(fmt, *args)


def main():
    print("Margins is running at:  http://localhost:%d/app/   (Product Page: http://localhost:%d/)" % (PORT, PORT))
    print("AI review:", f"ON (model {MODEL})" if key_is_set() else "OFF (add OPENROUTER_API_KEY to .env)")
    print("Press Control + C to stop.")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
