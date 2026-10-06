# Lagerfunk runner

Public on purpose: GitHub Actions is free and unlimited for public repositories. It checks shop prices and stock for
the Telegram channel [t.me/lagerfunk](https://t.me/lagerfunk) and posts restocks and deals.

- `.github/workflows/lagerfunk.yml` runs `deploy/run.mjs` every 10 minutes (shops) and every hour (product feeds).
  It runs the code at the tag `last-known-good`, which only the smoke test moves.
- `.github/workflows/watchdog.yml` checks every hour (and after any failed run) that a good run happened in the last
  40 minutes, alerts the owner's admin chat, re-enables a disabled schedule, backs up the state daily and sends a digest.
- `.github/workflows/smoke.yml` tests every push to main (fixtures, then a live dry run) before it goes live.
- `.github/workflows/ops.yml`: rollback, restore, backup, retract a false post, digest, status. By hand only.
- `deploy/config/breakers.json` holds every safety threshold (circuit breakers, dead-man switch, backups).
- `watchlist.json` is the list of products. `monitor/` reads shops and feeds, `bot/` writes the Telegram posts.
- The `state` branch holds the run state (price history, what was already posted), `activity.jsonl` (one line per
  run) and `status.json` (health and heartbeat). The `ops` branch holds the watchdog's memory and 7 daily backups.
  Both contain public data only: prices, stock, post history. No keys, no personal data.
- Keys (Telegram bot token, affiliate feed URLs) are repository secrets and never appear in files or logs.

Posts that contain affiliate links start with "Anzeige". Prices are shown with the time they were checked.

## Setup

1. Settings, Actions, General, Workflow permissions: **Read and write permissions** (the run saves its state on the `state` branch).
2. Settings, Secrets and variables, Actions, secrets: `TELEGRAM_BOT_TOKEN` (required to post), `TELEGRAM_ADMIN_CHAT_ID`
   (the owner's private chat with the bot: alerts and the daily digest), `TELEGRAM_CHAT_ID_STAGING` (a private test
   channel). Optional: `ADMIN_IDS`, `AWIN_AFFILIATE_ID`, `AWIN_MIDS`, `AWIN_API_TOKEN`, `TRADEDOUBLER_SITE_ID`, and one feed
   link per shop that approved the affiliate programme: `FEED_URL_PROSHOP`, `FEED_URL_CYBERPORT`,
   `FEED_URL_COMPUTERUNIVERSE`, `FEED_URL_CASEKING`, `FEED_URL_ALTERNATE`, `FEED_URL_GALAXUS`. A feed switches on as soon as
   its secret exists.
3. Posts go to the staging channel until the variable `LAGERFUNK_CHANNEL` is set to `public` (Settings, Variables).
   `LAGERFUNK_PAUSE` = 1 holds every post during an incident.
4. First run: Actions, lagerfunk, Run workflow, mode `all`, tick "silent" (learns prices, posts nothing). Then the schedule runs by itself.

Without `TELEGRAM_BOT_TOKEN` a normal run stops with a clear error. A silent or dry run works without any secret.

Check it on your own computer (Node 22): `node deploy/run.mjs --mode status`, or `node deploy/run.mjs --mode watch --dry-run`.
GitHub switches schedules off after 60 days without a commit to the main branch: any small commit resets that.

Prices and stock are read from the shops' public pages and affiliate feeds. This is an automatic check, not a guarantee.
