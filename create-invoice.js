import Stripe from "stripe";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { parse as parseDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Read .env into a local object instead of `dotenv/config`, which copies every key into the
// global process.env for the whole Node process. Keeping secrets local means a compromised
// dependency can't just grep process.env from anywhere to steal them - it would need to
// specifically target this module. Real environment variables (e.g. set by launchd) still work
// as a fallback for anything not present in .env.
const dotenvFile = (() => {
  try {
    return parseDotenv(readFileSync(join(__dirname, ".env")));
  } catch {
    return {};
  }
})();

function getEnv(name) {
  return dotenvFile[name] ?? process.env[name];
}

function requireEnv(name) {
  const value = getEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseDate(value, name) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`${name} must be in YYYY-MM-DD format, got: ${value}`);
  }
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

function parseNonNegativeInt(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative whole number, got: ${value}`);
  }
  return parsed;
}

function parsePositiveInt(value, name) {
  const parsed = parseNonNegativeInt(value, name);
  if (parsed === 0) {
    throw new Error(`${name} must be greater than 0, got: ${value}`);
  }
  return parsed;
}

function parsePositiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got: ${value}`);
  }
  return parsed;
}

const CALENDAR_EVENT_NAME = getEnv("CALENDAR_EVENT_NAME") || "Create Invoice";

const stripe = new Stripe(requireEnv("STRIPE_SECRET_KEY"));
const CUSTOMER_ID = requireEnv("STRIPE_CUSTOMER_ID");
const PRICE_ID = requireEnv("STRIPE_PRICE_ID");
const TEMPLATE_ID = getEnv("STRIPE_TEMPLATE_ID");

const CLIENT_NAME = requireEnv("CLIENT_NAME");
const HOURS_PER_PERIOD = parsePositiveNumber(requireEnv("HOURS_PER_PERIOD"), "HOURS_PER_PERIOD");
const PERIOD_DAYS = parsePositiveInt(getEnv("PERIOD_DAYS") || 14, "PERIOD_DAYS");
const DUE_DAYS_AFTER_INVOICE = parseNonNegativeInt(
  getEnv("DUE_DAYS_AFTER_INVOICE") || 14,
  "DUE_DAYS_AFTER_INVOICE"
);
const SERVICE_DAYS_BEFORE_INVOICE = parseNonNegativeInt(
  getEnv("SERVICE_DAYS_BEFORE_INVOICE") || PERIOD_DAYS - 3,
  "SERVICE_DAYS_BEFORE_INVOICE"
);
const INVOICE_DESCRIPTION =
  getEnv("INVOICE_DESCRIPTION") || "Consulting services. Review and update memo before sending.";
const INVOICE_ITEM_DESCRIPTION = getEnv("INVOICE_ITEM_DESCRIPTION") || "Consulting services";

// First invoice date in the recurring series. Every subsequent period is exactly PERIOD_DAYS later.
const ANCHOR_INVOICE_DATE = parseDate(requireEnv("ANCHOR_INVOICE_DATE"), "ANCHOR_INVOICE_DATE");

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function daysBetween(a, b) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((startOfDay(b) - startOfDay(a)) / msPerDay);
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function noonUnix(date) {
  return Math.floor(
    new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).getTime() / 1000
  );
}

function periodFromPeriodsElapsed(periodsElapsed) {
  const invoiceDate = addDays(ANCHOR_INVOICE_DATE, periodsElapsed * PERIOD_DAYS);
  const serviceEnd = invoiceDate;
  const serviceStart = addDays(invoiceDate, -SERVICE_DAYS_BEFORE_INVOICE);
  const dueDate = addDays(invoiceDate, DUE_DAYS_AFTER_INVOICE);
  return { invoiceDate, serviceStart, serviceEnd, dueDate };
}

// Number of full periods that have elapsed as of `today`, always rounding down so the result
// never points at a period that hasn't happened yet. Negative before ANCHOR_INVOICE_DATE. Used
// for every period lookup (on-time, --force, catch-up) so there's a single source of truth for
// "which period are we talking about", instead of a separate rounding-based variant that could
// snap forward to a not-yet-due period when run off-cycle.
function periodsElapsedAsOf(today) {
  const offset = daysBetween(ANCHOR_INVOICE_DATE, today);
  return Math.floor(offset / PERIOD_DAYS);
}

function isInvoiceFriday(today) {
  const offset = daysBetween(ANCHOR_INVOICE_DATE, today);
  return offset % PERIOD_DAYS === 0;
}

// AppleScript's "whose start date" filter only matches an event's first occurrence, not
// future instances of a recurring event, so instead we read the event's own start date +
// recurrence rule once and compute occurrences ourselves.
async function findCalendarSeries() {
  const script = `
    tell application "Calendar"
      repeat with c in calendars
        set matches to (every event of c whose summary contains "${CALENDAR_EVENT_NAME}")
        if (count of matches) > 0 then
          set e to item 1 of matches
          set d to start date of e
          set mo to (month of d) as integer
          return (year of d as string) & "-" & (mo as string) & "-" & (day of d as string) & "||" & (recurrence of e as string)
        end if
      end repeat
      return ""
    end tell
  `;
  const { stdout } = await execFileAsync("osascript", ["-e", script]);
  const output = stdout.trim();
  if (!output) return null;

  const [datePart, recurrence] = output.split("||");
  const [year, month, day] = datePart.split("-").map(Number);
  const seriesStart = startOfDay(new Date(year, month - 1, day));

  const intervalMatch = recurrence.match(/FREQ=WEEKLY;INTERVAL=(\d+)/);
  const intervalWeeks = intervalMatch ? Number(intervalMatch[1]) : 1;

  return { seriesStart, intervalWeeks };
}

// Returns true/false if the Calendar check succeeded, or null if it couldn't be performed
// (e.g. Calendar access not yet granted to osascript, or no matching event exists at all).
async function hasCalendarEventToday(today) {
  try {
    const series = await findCalendarSeries();
    if (!series) {
      console.warn(`No "${CALENDAR_EVENT_NAME}" event found in any calendar, falling back to date math.`);
      return null;
    }
    const { seriesStart, intervalWeeks } = series;
    if (today.getDay() !== seriesStart.getDay()) return false;
    const weeksSinceStart = daysBetween(seriesStart, today) / 7;
    return weeksSinceStart >= 0 && weeksSinceStart % intervalWeeks === 0;
  } catch (error) {
    console.warn(`Calendar check unavailable (${error.message.split("\n")[0]}), falling back to date math.`);
    return null;
  }
}

async function notify(message, title = "Recurring Invoice Automation") {
  try {
    await execFileAsync("osascript", [
      "-e",
      `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
    ]);
  } catch (error) {
    console.warn(`Could not send notification (${error.message.split("\n")[0]}).`);
  }
}

async function findExistingInvoice(serviceStart, serviceEnd) {
  const recent = await stripe.invoices.list({ customer: CUSTOMER_ID, limit: 100 });
  return (
    recent.data.find(
      (inv) =>
        inv.metadata?.service_start === formatDate(serviceStart) &&
        inv.metadata?.service_end === formatDate(serviceEnd)
    ) ?? null
  );
}

async function invoiceAlreadyExists(serviceStart, serviceEnd) {
  return (await findExistingInvoice(serviceStart, serviceEnd)) !== null;
}

async function addInvoiceItem(invoiceId, serviceStart, serviceEnd) {
  await stripe.invoiceItems.create(
    {
      customer: CUSTOMER_ID,
      invoice: invoiceId,
      pricing: { price: PRICE_ID },
      quantity: HOURS_PER_PERIOD,
      description: INVOICE_ITEM_DESCRIPTION,
      period: {
        start: noonUnix(serviceStart),
        end: noonUnix(serviceEnd),
      },
    },
    { idempotencyKey: `invoiceitem_${invoiceId}` }
  );
}

async function createConsultingInvoice({ invoiceDate, serviceStart, serviceEnd, dueDate }) {
  const existing = await findExistingInvoice(serviceStart, serviceEnd);
  if (existing) {
    // A prior run can have created the invoice but failed before adding its line item (e.g. a
    // network blip between the two Stripe calls). Rather than treating that empty draft as done
    // forever, finish it instead of silently skipping.
    if (existing.lines.data.length > 0) {
      console.log(
        `Draft already exists for ${formatDate(serviceStart)} - ${formatDate(serviceEnd)}, skipping.`
      );
      return null;
    }
    console.warn(
      `Found invoice ${existing.id} for ${formatDate(serviceStart)} - ${formatDate(serviceEnd)} with no line items, completing it.`
    );
    await addInvoiceItem(existing.id, serviceStart, serviceEnd);
    console.log(
      `Completed invoice: ${existing.id} | ${formatDate(serviceStart)} - ${formatDate(serviceEnd)} | due ${formatDate(dueDate)}`
    );
    return existing;
  }

  const invoice = await stripe.invoices.create(
    {
      customer: CUSTOMER_ID,
      collection_method: "send_invoice",
      due_date: noonUnix(dueDate),
      auto_advance: false,
      ...(TEMPLATE_ID ? { rendering: { template: TEMPLATE_ID } } : {}),
      description: INVOICE_DESCRIPTION,
      metadata: {
        client: CLIENT_NAME,
        service_start: formatDate(serviceStart),
        service_end: formatDate(serviceEnd),
        intended_invoice_date: formatDate(invoiceDate),
      },
    },
    { idempotencyKey: `invoice_${CUSTOMER_ID}_${formatDate(serviceStart)}_${formatDate(serviceEnd)}` }
  );

  await addInvoiceItem(invoice.id, serviceStart, serviceEnd);

  console.log(
    `Draft invoice created: ${invoice.id} | ${formatDate(serviceStart)} - ${formatDate(serviceEnd)} | due ${formatDate(dueDate)}`
  );
  return invoice;
}

// Creates the invoice for `period` under a given `context` ("scheduled run", "forced run", or
// "catch-up run") and notifies based on the outcome:
//   - created:          notify success
//   - null (skipped):   log only, no notification - a routine no-op isn't worth interrupting you
//   - throws:           notify failure, then rethrow so the caller still logs the error and the
//                        process exits non-zero, same as before
// `context` goes in the notification title, not just the body, so catch-up's "you missed it"
// signal stays visible even at a glance, rather than being buried inside the message text.
async function runAndNotify(period, context) {
  const title = `Invoice: ${context}`;
  try {
    const invoice = await createConsultingInvoice(period);
    if (invoice) {
      await notify(
        `Draft created for ${formatDate(period.serviceStart)} to ${formatDate(period.serviceEnd)}.`,
        title
      );
    }
    return invoice;
  } catch (error) {
    await notify(
      `Could not create invoice for ${formatDate(period.serviceStart)} to ${formatDate(period.serviceEnd)}: ${error.message}`,
      title
    );
    throw error;
  }
}

async function catchUpMissedInvoice(today) {
  const periodsElapsed = periodsElapsedAsOf(today);
  if (periodsElapsed < 0) return; // before ANCHOR_INVOICE_DATE, nothing to catch up on yet

  const period = periodFromPeriodsElapsed(periodsElapsed);

  // If the current period's invoice date is today, main() already decided (via the Calendar
  // check or Friday math) whether to invoice today and chose not to. Catch-up exists to fill in
  // periods that were missed on a *past* run, not to override today's decision with a
  // independently-computed anchor date that may have drifted from the Calendar's real cadence.
  if (period.invoiceDate.getTime() === today.getTime()) return;

  if (await invoiceAlreadyExists(period.serviceStart, period.serviceEnd)) {
    console.log(
      `${formatDate(today)}: not an invoice day, and ${formatDate(period.serviceStart)} to ${formatDate(period.serviceEnd)} is already invoiced. Skipping.`
    );
    return;
  }

  console.warn(
    `Missed invoice day for ${formatDate(period.serviceStart)} to ${formatDate(period.serviceEnd)} (due ${formatDate(period.invoiceDate)}). Creating catch-up draft.`
  );
  await runAndNotify(period, "catch-up run");
}

async function main() {
  const force = process.argv.includes("--force");
  const today = startOfDay(new Date());
  const period = periodFromPeriodsElapsed(periodsElapsedAsOf(today));

  if (force) {
    await runAndNotify(period, "forced run");
    return;
  }

  const calendarMatch = await hasCalendarEventToday(today);
  const shouldRunToday = calendarMatch === null ? isInvoiceFriday(today) : calendarMatch;

  if (shouldRunToday) {
    await runAndNotify(period, "scheduled run");
    return;
  }

  await catchUpMissedInvoice(today);
}

main().catch((error) => {
  console.error("Could not create invoice:", error.message);
  process.exit(1);
});
