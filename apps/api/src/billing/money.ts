/**
 * apps/api/src/billing/money.ts
 *
 * Usage: exact money arithmetic. Every amount in the database is an integer
 * number of micro-units (1 INR = 1_000_000 micros), so per-second usage never
 * loses precision. Convert only at the edges:
 *
 *   parseAmount("12.50")          // 12_500_000 micros
 *   toMinorUnits(12_500_000)      // 1250 paise (what Razorpay expects)
 *   fromMinorUnits(1250)          // 12_500_000 micros
 *   formatAmount(12_500_000)      // "12.50"
 */

export const MICROS_PER_UNIT = 1_000_000;
export const MICROS_PER_MINOR = 10_000;
/** Hours in a billing month, the convention DigitalOcean/Vultr use for monthly prices. */
export const HOURS_PER_MONTH = 730;

/** Parses a non-negative decimal string ("0.75", "12") into micros without floating-point error. */
export function parseAmount(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid amount: ${value}`);
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(6, "0"));
  return whole * MICROS_PER_UNIT + fraction;
}

/** Rounds micros to the nearest minor unit (paise), half away from zero. */
export function toMinorUnits(micros: number): number {
  return Math.sign(micros) * Math.round(Math.abs(micros) / MICROS_PER_MINOR);
}

export function fromMinorUnits(minor: number): number {
  return minor * MICROS_PER_MINOR;
}

/** Fixed two-decimal string, e.g. "-3.07". */
export function formatAmount(micros: number): string {
  const minor = toMinorUnits(micros);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
