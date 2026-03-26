# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Deployment

There is no local build step — the frontend is vanilla HTML/CSS/JS deployed directly to S3. Changes go live via GitHub Actions on push to `main`.

```bash
# Manual deploy (syncs to S3 and invalidates CloudFront)
bash deploy.sh

# Grant/revoke free access for a client
bash admin/grant-free-plan.sh <client-id>
bash admin/revoke-free-plan.sh <client-id>
```

**CI/CD:** `.github/workflows/deploy.yml` — push to `main` → S3 sync → CloudFront invalidation. Excludes `.git/`, `.github/`, `.md`, `.sh` files.

## Architecture

**Frontend** — Static HTML pages + `style.css` + vanilla JS, hosted on S3 behind CloudFront. No framework, no bundler.
- `app.js` — Shared header, nav, auth (Cognito), and modal logic used across all pages
- `chatbot.js` — Floating chat widget (used on HSS's own site for product demos)
- `chatbot-embed.js` — Embeddable chat widget clients install on their own sites

**Backend** — AWS Lambda (Node.js 20.x, ESM `.mjs`) behind API Gateway (`pd30lkyyof.execute-api.us-east-2`):

| Handler | Route | Purpose |
|---|---|---|
| `chat_handler.mjs` | `POST /chat` | Multi-provider AI chat with failover |
| `trial_handler.mjs` | `POST /trial/*` | Trial provisioning (14-day, 7 industry templates) |
| `payment_handler.mjs` | `POST /payment/*` | Stripe checkout + webhook |
| `contact_handler.mjs` | `POST /contact` | Contact form and job applications |
| `outreach_handler.mjs` | `POST /outreach` | Automated cold email campaigns |
| `index.mjs` | `GET/POST /admin/*` | Client CRUD, analytics, Cognito user mgmt |

**AI Provider Failover Chain** (in order):
1. Google Gemini 2.0 Flash
2. Groq Llama 3.3 70B
3. Mistral Small
4. OpenAI GPT-4o Mini
5. Anthropic Claude Sonnet 4

**Auth** — AWS Cognito (Client ID: `4349q6k1fa2vmf5mthuj65t44g`). Admin endpoints require a valid Cognito JWT.

**Data** — DynamoDB tables: `HSS-CLIENTS`, `HSS-TRIALS`, `HSS-CHATBOT-CONFIGS`, `HSS-ANALYTICS`, `HSS-LEADS`, `HSS-CONVERSATIONS`, `HSS-OUTREACH-PROSPECTS`.

**Email** — AWS SES from `contact@heinrichstech.com`.

**Payments** — Stripe. Standard plan: $499 setup + $49/mo. Pro plan: $999 setup + $99/mo.

## Key Conventions

- Lambda functions are ES modules (`.mjs`) — use `import`/`export`, not `require`.
- All Lambda handlers export a named `handler` function.
- CORS origins are validated per-request inside each handler — do not relax this.
- HTML escaping is used in `contact_handler.mjs` to prevent XSS in email bodies; maintain this pattern when handling user input.
- The chatbot config per client lives in `HSS-CHATBOT-CONFIGS` and drives system prompts, allowed topics, and trial limits.
- `DEPLOY.md` contains the canonical reference for AWS resource IDs, setup commands, and cost estimates.
