/**
 * Shapes for usage-based billing: the period arithmetic and the line items
 * an invoice is made of. Pure — no database, no dates from the clock — so
 * the close job and its tests reason about the same functions.
 */

export interface UsageLine {
  costCode: string;
  label: string;
  /** Debits in the period for this code — the number of things made. */
  requests: number;
  /** Net credits: debits less refunds. Can be negative when a refund lands after the debit's period. */
  credits: number;
  amountMinor: number;
}

export interface BillTo {
  company?: string;
  address?: string;
  taxId?: string;
  contact?: string;
}

/** The UTC calendar month containing `d`. */
export function monthOf(d: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { start, end };
}

/** The month after the one starting at `start`. */
export function nextMonth(start: Date): { start: Date; end: Date } {
  return monthOf(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)));
}

/** Minor units for `credits` at `per100Minor` per hundred, rounded half up. Never negative for a negative line — refunds reduce the total, they do not pay out. */
export function priceCredits(credits: number, per100Minor: number): number {
  return Math.round((credits * per100Minor) / 100);
}

/**
 * Price a period's raw usage. Each line is rounded on its own so the
 * printed lines add up to the printed subtotal; the minimum, when there is
 * one, is a separate line the customer can see rather than a silent bump.
 */
export function priceUsage(
  raw: Array<{ costCode: string; label: string; requests: number; credits: number }>,
  per100Minor: number,
  minimumMinor: number,
): { lines: UsageLine[]; credits: number; usageMinor: number; minimumMinor: number; totalMinor: number } {
  const lines = raw
    .filter((r) => r.credits !== 0 || r.requests !== 0)
    .map((r) => ({ ...r, amountMinor: priceCredits(r.credits, per100Minor) }))
    .sort((a, b) => b.amountMinor - a.amountMinor || a.costCode.localeCompare(b.costCode));
  const credits = lines.reduce((n, l) => n + l.credits, 0);
  const usageMinor = Math.max(
    0,
    lines.reduce((n, l) => n + l.amountMinor, 0),
  );
  const minimum = Math.max(0, minimumMinor - usageMinor);
  return { lines, credits, usageMinor, minimumMinor: minimum, totalMinor: usageMinor + minimum };
}

/** INV-202609-0042: the month it covers, then a running number within it. */
export function invoiceNumber(periodStart: Date, seq: number): string {
  const ym = `${periodStart.getUTCFullYear()}${String(periodStart.getUTCMonth() + 1).padStart(2, '0')}`;
  return `INV-${ym}-${String(seq).padStart(4, '0')}`;
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}
