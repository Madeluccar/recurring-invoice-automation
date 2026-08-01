# Recurring Invoice Automation

Automatically creates a draft Stripe invoice on a recurring schedule (for example, a fixed number of hours every two weeks). 

It watches a macOS Calendar event and, the moment it fires, generates the draft through the Stripe API on its own. No more doing
mental math on when a client's billing period ends or how many hours to bill them for. 

Designed to run as a scheduled job (cron or macOS `launchd`), it just runs on schedule and drops a ready to review draft into Stripe, 
so invoicing stops being something you have to remember to do.

This is a **template**. It ships with no client data, no contract terms, and no credentials.
Every value specific to your engagement lives in your own `.env` file, which is gitignored and
never committed.

## How it decides when to invoice

On each run, the script checks, in order:

1. Whether a recurring macOS Calendar event named `CALENDAR_EVENT_NAME` occurs today.
2. If Calendar access isn't available or no matching event exists, it falls back to pure date
   math from `ANCHOR_INVOICE_DATE` and `PERIOD_DAYS`.

If neither condition is met, it exits without creating anything. Pass `--force` to skip this
check and create the invoice for the current period regardless.

It also checks Stripe for an existing draft covering the same service period before creating a
new one, so re-running it (for example, after a failed run) won't create duplicates.

## Setup

1. Install dependencies. Use `npm ci`, not `npm install`. It installs the exact versions
   recorded in `package-lock.json` and verifies their integrity hashes, instead of resolving
   version ranges that could silently pull in a newer, unaudited release.
   ```
   npm ci
   ```
2. Copy the example env file and fill in your own values:
   ```
   cp .env.example .env
   ```
3. Edit `.env`:
   - `STRIPE_SECRET_KEY`: use a Stripe **restricted key** scoped to only `Invoices: Write` and
     `Invoice Items: Write`, not your full account secret key.
   - `STRIPE_CUSTOMER_ID`, `STRIPE_PRICE_ID`: from your Stripe dashboard.
   - `CLIENT_NAME`, `HOURS_PER_PERIOD`, `PERIOD_DAYS`, `DUE_DAYS_AFTER_INVOICE`,
     `ANCHOR_INVOICE_DATE`, `INVOICE_DESCRIPTION`, `INVOICE_ITEM_DESCRIPTION`: match these to
     your actual contract terms.
4. Run it manually to test:
   ```
   npm run invoice
   ```
   Or, to skip the Calendar/date check:
   ```
   npm run invoice:force
   ```

## Scheduling

Run it on whatever cadence covers your invoice days (daily is simplest). The script itself
decides whether to actually create an invoice that day.

**cron** (daily at 9am):
```
0 9 * * * cd /path/to/this/project && /usr/bin/env node create-invoice.js >> logs/invoice.log 2>> logs/invoice-error.log
```

**launchd** (macOS): create a `~/Library/LaunchAgents/com.yourname.invoicing.plist` with a
`StartCalendarInterval` and `ProgramArguments` pointing `node` at `create-invoice.js` in this
directory, then load it with `launchctl load`.

## Notes

- `logs/` and `.env` are gitignored. Don't remove those entries.
- Invoices are created as **drafts** (`auto_advance: false`), so you always review before sending.
