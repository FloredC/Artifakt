# Artifakt

**Turn a keyword and a quick finger-sketch into an artwork in the style of a feminist or queer artist — a card you can share.**

Live at **[artifakt.gallery](https://artifakt.gallery)** · built for mobile

---

## What it does

1. **Keyword** — you type one word: *water*, *home*, *chaos*.
2. **Scaffold** — AI generates a faint grey sketch from that word. Regenerate for alternatives.
3. **Trace** — you draw over the scaffold with your finger. The imperfection is the point.
4. **Artists** — your traced line is transformed in parallel by five artists. You pick one.
5. **Result** — the artwork fills the screen, and the card flips to reveal the artist's bio.

The artist's style is applied *after* tracing, never during. Your hand stays the primary author; the AI is a silent prosthetic, not a co-author.

## The artists

Louise Bourgeois · Kara Walker · Niki de Saint Phalle · Naoko Takeuchi · Keith Haring

The roster is fixed and curated, honouring a lineage of female, queer and trans artists. Your keyword shapes the generation prompt — it never changes which artists appear.

## Why it's built this way

The thesis is **visible labor = proof of care**. A hand-drawn mark is a costly signal: proof the sender spent time on the recipient. That counters three problems at once:

- **Algorithm discount** — when sending costs nothing, receiving is worth less. Tracing puts the cost back.
- **Creative anxiety** — adults don't draw because they fear the result. The scaffold removes the blank page.
- **AI authorship** — a fully generated gift feels hollow. Here the user made the line; the model only dresses it.

Sixty seconds of tracing is enough to create ownership. The emotional choreography — the *sequence* of steps — is the design work, not the model choice.

## How it works

No framework, no build step, no backend of its own. The whole app is one `index.html` that runs in any mobile browser.

Image generation goes through [fal.ai](https://fal.ai):

- **Scaffold** — `fal-ai/flux/schnell`, a single call
- **Artist styling** — `fal-ai/flux/dev/image-to-image`, run **twice** per artist — pass 1 for gesture and material, pass 2 for colour and motifs — each at a strength tuned per artist (0.75–0.82, then 0.80–0.90)

A full visit costs 11 calls: one scaffold, plus five artists × two passes generated in parallel. The Worker's per-visitor daily cap of 24 is sized against that.

Every artist prompt opens with **"KEEP THE EXACT LINE COMPOSITION"**. Without it the model ignores the sketch and draws an icon *of* the artist — a spider for Bourgeois, silhouettes for Walker. With it, your lines become the artist's material.

Requests are proxied through a **Cloudflare Worker** (`worker/`) so the fal.ai key never reaches the browser. The Worker also rate-limits by IP using KV, and pings an [ntfy](https://ntfy.sh) topic on unusual traffic.

## Layout

```
index.html      the entire app
worker/         Cloudflare Worker — API proxy, rate limiting, alerts
avatars/        artist portraits for the result-card flip side
backups/        dated snapshots of index.html
CNAME           custom domain for GitHub Pages
```

## Running locally

No tooling required — open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
```

It calls the deployed Worker, so image generation works without any local secrets. Use a mobile viewport in devtools; the layout is mobile-first and desktop shows a "works best on mobile" nudge.

## Deploying

**Site** — GitHub Pages serves `main` from the repo root. Push to `main` and it's live.

**Worker** — from `worker/`:

```bash
wrangler deploy
```

Secrets are never committed. Set them once with `wrangler secret put FAL_API_KEY` and `wrangler secret put NTFY_TOPIC`, and create the KV namespace with `wrangler kv namespace create RATE_LIMIT_KV`.

## Known issues

- Kara Walker's flood-fill breaks on mechanical or open shapes — a bicycle can fill the canvas black.
- The result card spins during generation with no label explaining the wait.
- The scaffold reads as too finished, which nudges people into pixel-perfect tracing instead of loose marks.

## Credits

Designed and built by [Flore de Crombrugghe](https://github.com/FloredC), entirely in Claude Code. Artwork styles reference the named artists; all generated output is derivative and non-commercial.
