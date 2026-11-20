import { Decimal } from 'decimal.js';

/** A Decimal constructor isolated from the global one, so settings can't leak between packages. */
export const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof Dec>;

export type DecimalInput = string | number | Dec;

export function dec(value: DecimalInput): Dec {
  return new Dec(value);
}

/** Round a money amount to 2 decimal places, half-up. */
export function roundMoney(value: DecimalInput): Dec {
  return dec(value).toDecimalPlaces(2, Dec.ROUND_HALF_UP);
}

/** Money as a fixed 2-decimal string — the wire format used by the API. */
export function money(value: DecimalInput): string {
  return roundMoney(value).toFixed(2);
}

export const CURRENCY = 'EGP';
