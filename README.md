# Lagerfunk runner

Public on purpose: GitHub Actions is free and unlimited for public repositories. It checks shop prices and stock for
the Telegram channel [t.me/lagerfunk](https://t.me/lagerfunk) and posts restocks and deals.

- `.github/workflows/lagerfunk.yml` runs `deploy/run.mjs` every 10 minutes (shops) and every hour (product feeds).
- `watchlist.json` is the list of products. `monitor/` reads shops and feeds, `bot/` writes the Telegram posts.
- The `state` branch holds the run state (price history, what was already posted) and `activity.jsonl`, one line per run.
  It contains public data only: prices, stock, post history. No keys.
- Keys (Telegram bot token, affiliate feed URLs) are repository secrets and never appear in files or logs.

Posts that contain affiliate links start with "Anzeige". Prices are shown with the time they were checked.

## Setup

1. Settings, Actions, General, Workflow permissions: **Read and write permissions** (the run saves its state on the `state` branch).
2. Settings, Secrets and variables, Actions, secrets: `TELEGRAM_BOT_TOKEN` (required to post). Optional: `ADMIN_IDS`,
   `AWIN_AFFILIATE_ID`, `AWIN_MIDS`, `AWIN_API_TOKEN`, and one feed link per shop that approved the affiliate programme:
   `FEED_URL_PROSHOP`, `FEED_URL_CYBERPORT`, `FEED_URL_COMPUTERUNIVERSE`, `FEED_URL_CASEKING`, `FEED_URL_ALTERNATE`,
   `FEED_URL_GALAXUS`. A feed switches on as soon as its secret exists.
3. First run: Actions, lagerfunk, Run workflow, mode `all`, tick "silent" (learns prices, posts nothing). Then the schedule runs by itself.

Without `TELEGRAM_BOT_TOKEN` a normal run stops with a clear error. A silent or dry run works without any secret.

Check it on your own computer (Node 22): `node deploy/run.mjs --mode status`, or `node deploy/run.mjs --mode watch --dry-run`.
GitHub switches schedules off after 60 days without a commit to the main branch: any small commit resets that.

Prices and stock are read from the shops' public pages and affiliate feeds. This is an automatic check, not a guarantee.
