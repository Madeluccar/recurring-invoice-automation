import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { addDays, createSchedule, daysBetween, formatDate, startOfDay } from "../schedule.js";

// Local-time date from "YYYY-MM-DD", the same way create-invoice.js parses ANCHOR_INVOICE_DATE.
const d = (iso) => {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day);
};

const formatPeriod = (period) =>
  Object.fromEntries(Object.entries(period).map(([key, date]) => [key, formatDate(date)]));

describe("date helpers", () => {
  test("formatDate pads month and day and uses the local calendar date", () => {
    assert.equal(formatDate(d("2026-01-05")), "2026-01-05");
    assert.equal(formatDate(new Date(2026, 11, 31, 23, 59)), "2026-12-31");
  });

  test("addDays rolls over months and years without mutating its input", () => {
    const start = d("2026-01-31");
    assert.equal(formatDate(addDays(start, 1)), "2026-02-01");
    assert.equal(formatDate(addDays(d("2025-12-31"), 1)), "2026-01-01");
    assert.equal(formatDate(addDays(d("2026-03-01"), -1)), "2026-02-28");
    assert.equal(formatDate(start), "2026-01-31");
  });

  test("startOfDay drops the time of day", () => {
    assert.equal(startOfDay(new Date(2026, 4, 9, 17, 45)).getTime(), d("2026-05-09").getTime());
  });

  test("daysBetween counts calendar days, ignoring time of day", () => {
    assert.equal(daysBetween(new Date(2026, 0, 1, 23, 59), new Date(2026, 0, 2, 0, 1)), 1);
    assert.equal(daysBetween(d("2026-01-02"), d("2026-01-16")), 14);
    assert.equal(daysBetween(d("2026-01-16"), d("2026-01-02")), -14);
  });

  test("daysBetween stays whole across daylight-saving changes", () => {
    // US clocks change on 2026-03-08 and 2026-11-01; those days are 23 and 25 hours long.
    assert.equal(daysBetween(d("2026-03-07"), d("2026-03-09")), 2);
    assert.equal(daysBetween(d("2026-10-31"), d("2026-11-02")), 2);
  });
});

describe("every-n-days schedule (biweekly Fridays)", () => {
  const schedule = createSchedule({
    schedule: "every-n-days",
    anchorInvoiceDate: d("2026-01-02"), // a Friday
    periodDays: 14,
    serviceDaysBeforeInvoice: 11,
    dueDateRule: "days-after",
    dueDaysAfterInvoice: 14,
  });

  test("periodsElapsedAsOf rounds down to the last period that has started", () => {
    assert.equal(schedule.periodsElapsedAsOf(d("2026-01-02")), 0);
    assert.equal(schedule.periodsElapsedAsOf(d("2026-01-15")), 0);
    assert.equal(schedule.periodsElapsedAsOf(d("2026-01-16")), 1);
    assert.equal(schedule.periodsElapsedAsOf(d("2026-03-26")), 5);
    assert.equal(schedule.periodsElapsedAsOf(d("2026-03-27")), 6); // past the March clock change
  });

  test("periodsElapsedAsOf is negative before the anchor", () => {
    assert.equal(schedule.periodsElapsedAsOf(d("2026-01-01")), -1);
    assert.equal(schedule.periodsElapsedAsOf(d("2025-12-19")), -1);
    assert.equal(schedule.periodsElapsedAsOf(d("2025-12-18")), -2);
  });

  test("the anchor period ends on the anchor date", () => {
    assert.deepEqual(formatPeriod(schedule.periodFromPeriodsElapsed(0)), {
      invoiceDate: "2026-01-02",
      serviceStart: "2025-12-22",
      serviceEnd: "2026-01-02",
      dueDate: "2026-01-16",
    });
  });

  test("later periods step forward by periodDays", () => {
    assert.deepEqual(formatPeriod(schedule.periodFromPeriodsElapsed(1)), {
      invoiceDate: "2026-01-16",
      serviceStart: "2026-01-05",
      serviceEnd: "2026-01-16",
      dueDate: "2026-01-30",
    });
    assert.equal(formatDate(schedule.periodFromPeriodsElapsed(6).invoiceDate), "2026-03-27");
  });

  test("isInvoiceFriday is true only on period boundaries", () => {
    assert.equal(schedule.isInvoiceFriday(d("2026-01-02")), true);
    assert.equal(schedule.isInvoiceFriday(d("2026-01-16")), true);
    assert.equal(schedule.isInvoiceFriday(d("2026-03-27")), true);
    assert.equal(schedule.isInvoiceFriday(d("2026-01-09")), false); // the off Friday
    assert.equal(schedule.isInvoiceFriday(d("2026-01-15")), false);
    assert.equal(schedule.isInvoiceFriday(d("2026-01-17")), false);
  });

  test("every invoice date maps back to its own period for two years", () => {
    for (let index = 0; index < 52; index += 1) {
      const { invoiceDate } = schedule.periodFromPeriodsElapsed(index);
      assert.equal(invoiceDate.getDay(), 5, `period ${index} is not a Friday`);
      assert.equal(schedule.periodsElapsedAsOf(invoiceDate), index);
      assert.equal(schedule.periodsElapsedAsOf(addDays(invoiceDate, -1)), index - 1);
      assert.equal(schedule.isInvoiceFriday(invoiceDate), true);
    }
  });
});

describe("semimonthly schedule (1st and 16th)", () => {
  const schedule = createSchedule({
    schedule: "semimonthly",
    anchorInvoiceDate: d("2025-10-16"),
    dueDateRule: "days-after",
    dueDaysAfterInvoice: 14,
  });

  test("an invoice on the 16th covers the 1st through the 15th", () => {
    assert.deepEqual(formatPeriod(schedule.periodFromPeriodsElapsed(0)), {
      invoiceDate: "2025-10-16",
      serviceStart: "2025-10-01",
      serviceEnd: "2025-10-15",
      dueDate: "2025-10-30",
    });
  });

  test("an invoice on the 1st covers the 16th through the end of the previous month", () => {
    assert.deepEqual(formatPeriod(schedule.periodFromPeriodsElapsed(1)), {
      invoiceDate: "2025-11-01",
      serviceStart: "2025-10-16",
      serviceEnd: "2025-10-31",
      dueDate: "2025-11-15",
    });
  });

  test("periods cross the year boundary and a short February", () => {
    assert.deepEqual(formatPeriod(schedule.periodFromPeriodsElapsed(5)), {
      invoiceDate: "2026-01-01",
      serviceStart: "2025-12-16",
      serviceEnd: "2025-12-31",
      dueDate: "2026-01-15",
    });
    const march = schedule.periodFromPeriodsElapsed(9);
    assert.equal(formatDate(march.invoiceDate), "2026-03-01");
    assert.equal(formatDate(march.serviceStart), "2026-02-16");
    assert.equal(formatDate(march.serviceEnd), "2026-02-28");
  });

  test("a leap-year February ends on the 29th", () => {
    const leap = createSchedule({
      schedule: "semimonthly",
      anchorInvoiceDate: d("2024-01-01"),
      dueDateRule: "days-after",
      dueDaysAfterInvoice: 14,
    });
    const march = leap.periodFromPeriodsElapsed(4);
    assert.equal(formatDate(march.invoiceDate), "2024-03-01");
    assert.equal(formatDate(march.serviceEnd), "2024-02-29");
  });

  test("periodsElapsedAsOf changes only on the 1st and 16th", () => {
    assert.equal(schedule.periodsElapsedAsOf(d("2025-10-16")), 0);
    assert.equal(schedule.periodsElapsedAsOf(d("2025-10-31")), 0);
    assert.equal(schedule.periodsElapsedAsOf(d("2025-11-01")), 1);
    assert.equal(schedule.periodsElapsedAsOf(d("2025-11-15")), 1);
    assert.equal(schedule.periodsElapsedAsOf(d("2025-11-16")), 2);
    assert.equal(schedule.periodsElapsedAsOf(d("2026-01-01")), 5);
  });

  test("days before the anchor are negative, even in the anchor's own month", () => {
    assert.equal(schedule.periodsElapsedAsOf(d("2025-10-05")), -1);
    assert.equal(schedule.periodsElapsedAsOf(d("2025-10-15")), -1);
  });

  test("isInvoiceFriday is true on the 1st and 16th from the anchor onward", () => {
    assert.equal(schedule.isInvoiceFriday(d("2025-10-16")), true);
    assert.equal(schedule.isInvoiceFriday(d("2025-11-01")), true);
    assert.equal(schedule.isInvoiceFriday(d("2025-11-02")), false);
    assert.equal(schedule.isInvoiceFriday(d("2025-11-15")), false);
    assert.equal(schedule.isInvoiceFriday(d("2025-10-01")), false); // a 1st, but before the anchor
  });

  test("service periods are contiguous and map back to their index for two years", () => {
    for (let index = 0; index < 48; index += 1) {
      const period = schedule.periodFromPeriodsElapsed(index);
      const next = schedule.periodFromPeriodsElapsed(index + 1);
      assert.equal(schedule.periodsElapsedAsOf(period.invoiceDate), index);
      assert.equal(schedule.periodsElapsedAsOf(addDays(next.invoiceDate, -1)), index);
      assert.equal(formatDate(addDays(period.serviceEnd, 1)), formatDate(next.serviceStart));
      assert.equal(formatDate(addDays(period.serviceEnd, 1)), formatDate(period.invoiceDate));
    }
  });
});

describe("due dates", () => {
  const base = {
    schedule: "every-n-days",
    anchorInvoiceDate: d("2026-01-02"),
    periodDays: 14,
    serviceDaysBeforeInvoice: 11,
  };

  test("days-after adds dueDaysAfterInvoice, and 0 means due on the invoice date", () => {
    const net30 = createSchedule({ ...base, dueDateRule: "days-after", dueDaysAfterInvoice: 30 });
    assert.equal(formatDate(net30.dueDateFor(d("2026-01-16"))), "2026-02-15");
    const sameDay = createSchedule({ ...base, dueDateRule: "days-after", dueDaysAfterInvoice: 0 });
    assert.equal(formatDate(sameDay.dueDateFor(d("2026-01-16"))), "2026-01-16");
  });

  test("next-friday is the first Friday strictly after the invoice date", () => {
    const { dueDateFor } = createSchedule({ ...base, dueDateRule: "next-friday" });
    assert.equal(formatDate(dueDateFor(d("2026-01-16"))), "2026-01-23"); // Friday -> next Friday
    assert.equal(formatDate(dueDateFor(d("2026-01-15"))), "2026-01-16"); // Thursday
    assert.equal(formatDate(dueDateFor(d("2026-01-17"))), "2026-01-23"); // Saturday
    assert.equal(formatDate(dueDateFor(d("2026-01-05"))), "2026-01-09"); // Monday
    assert.equal(formatDate(dueDateFor(d("2025-12-29"))), "2026-01-02"); // across the new year
  });
});
