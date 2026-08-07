# VDS Cloudflare Worker

This folder will hold the Cloudflare Worker source code that powers county-availability checks, Stripe Checkout session creation, and Stripe webhook handling (subscription created → lock county in Workers KV; subscription canceled → unlock county).

**Status:** Not yet implemented. This is a placeholder for a separate design/build round — see `docs/superpowers/specs/` for the static-site spec that shipped first.

**Deploys separately from the static site** via `wrangler`, not via GitHub Pages. When the Worker is built, this file will be replaced with real deploy instructions (`wrangler deploy`, `wrangler secret put STRIPE_SECRET_KEY`, etc.).
