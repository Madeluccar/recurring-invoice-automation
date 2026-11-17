// Date math for the invoice schedule, kept free of Stripe, .env and Calendar access so it can be
// unit-tested (see test/schedule.test.js). create-invoice.js builds one schedule from its config
// and uses the returned functions for every period lookup.

export function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function daysBetween(a, b) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((startOfDay(b) - startOfDay(a)) / msPerDay);
}

export function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// schedule:                 "every-n-days" or "semimonthly"
// anchorInvoiceDate:        first invoice date in the series (a 1st or 16th when semimonthly)
// periodDays:               days between invoices (every-n-days only)
// serviceDaysBeforeInvoice: how far before the invoice date the service period starts
//                           (every-n-days only)
// dueDateRule:              "days-after" or "next-friday"
// dueDaysAfterInvoice:      days until due (days-after only)
export function createSchedule({
  schedule,
  anchorInvoiceDate,
  periodDays,
  serviceDaysBeforeInvoice,
  dueDateRule,
  dueDaysAfterInvoice,
}) {
  function dueDateFor(invoiceDate) {
    if (dueDateRule === "next-friday") {
      const FRIDAY = 5;
      return addDays(invoiceDate, (FRIDAY - invoiceDate.getDay() + 7) % 7 || 7);
    }
    return addDays(invoiceDate, dueDaysAfterInvoice);
  }

  function periodFromPeriodsElapsed(periodsElapsed) {
    if (schedule === "semimonthly") return semimonthlyPeriod(periodsElapsed);
    const invoiceDate = addDays(anchorInvoiceDate, periodsElapsed * periodDays);
    const serviceEnd = invoiceDate;
    const serviceStart = addDays(invoiceDate, -serviceDaysBeforeInvoice);
    const dueDate = dueDateFor(invoiceDate);
    return { invoiceDate, serviceStart, serviceEnd, dueDate };
  }

  // Semimonthly periods are counted in half-months from anchorInvoiceDate: index 0 is the anchor,
  // index 1 the next 1st/16th, and so on. An invoice on the 1st covers the 16th through the last
  // day of the previous month; an invoice on the 16th covers the 1st through the 15th.
  function semimonthlyIndex(date) {
    const half = (d) => d.getFullYear() * 24 + d.getMonth() * 2 + (d.getDate() >= 16 ? 1 : 0);
    return half(date) - half(anchorInvoiceDate);
  }

  function semimonthlyPeriod(periodsElapsed) {
    const anchorHalf = anchorInvoiceDate.getDate() === 16 ? 1 : 0;
    const totalHalf = anchorHalf + periodsElapsed;
    const monthOffset = Math.floor(totalHalf / 2);
    const isSixteenth = totalHalf % 2 === 1;
    const invoiceDate = new Date(
      anchorInvoiceDate.getFullYear(),
      anchorInvoiceDate.getMonth() + monthOffset,
      isSixteenth ? 16 : 1
    );
    const serviceStart = isSixteenth
      ? new Date(invoiceDate.getFullYear(), invoiceDate.getMonth(), 1)
      : new Date(invoiceDate.getFullYear(), invoiceDate.getMonth() - 1, 16);
    const serviceEnd = addDays(invoiceDate, -1);
    const dueDate = dueDateFor(invoiceDate);
    return { invoiceDate, serviceStart, serviceEnd, dueDate };
  }

  // Number of full periods that have elapsed as of `today`, always rounding down so the result
  // never points at a period that hasn't happened yet. Negative before anchorInvoiceDate. Used
  // for every period lookup (on-time, --force, catch-up) so there's a single source of truth for
  // "which period are we talking about", instead of a separate rounding-based variant that could
  // snap forward to a not-yet-due period when run off-cycle.
  function periodsElapsedAsOf(today) {
    if (schedule === "semimonthly") {
      // Before the anchor's own 1st/16th, the index can be 0 while today is still earlier (e.g.
      // anchor Oct 16, today Oct 5), so check the date itself to keep "before anchor" negative.
      return today < anchorInvoiceDate ? -1 : semimonthlyIndex(today);
    }
    const offset = daysBetween(anchorInvoiceDate, today);
    return Math.floor(offset / periodDays);
  }

  function isInvoiceFriday(today) {
    if (schedule === "semimonthly") {
      return today >= anchorInvoiceDate && [1, 16].includes(today.getDate());
    }
    const offset = daysBetween(anchorInvoiceDate, today);
    return offset % periodDays === 0;
  }

  return { dueDateFor, periodFromPeriodsElapsed, periodsElapsedAsOf, isInvoiceFriday };
}
