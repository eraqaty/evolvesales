import { dec, type DecimalInput, type Dec, roundMoney } from '../money.js';

export interface CalcLineInput {
  quantity: DecimalInput;
  unitPrice: DecimalInput;
  /** Percentage 0–100. */
  lineDiscountPct: DecimalInput;
  /** Fraction, e.g. 0.14 for 14 %. Copied from the product. */
  taxRate: DecimalInput;
}

export interface CalcInput {
  /** Invoice-level percentage 0–100, applied after line discounts and before tax. */
  headerDiscountPct: DecimalInput;
  lines: readonly CalcLineInput[];
}

export interface CalcLineResult {
  lineGross: string;
  lineDiscount: string;
  headerDiscountShare: string;
  taxableAmount: string;
  taxAmount: string;
  lineTotal: string;
}

export interface CalcResult {
  lines: CalcLineResult[];
  subtotal: string;
  discountTotal: string;
  taxableTotal: string;
  taxTotal: string;
  grandTotal: string;
}

const ZERO = dec(0);
const HUNDRED = dec(100);

/**
 * Authoritative invoice math (EGP, 2 decimals, ROUND_HALF_UP at each money step).
 *
 * Per line: gross = qty × price; discount = gross × line%; net = gross − discount.
 * Header discount: total = round(Σ net × header%), shared across lines in proportion to net
 * (same % on every line); any rounding remainder goes to the line with the largest net, so
 * Σ shares always equals the invoice-level header discount.
 * Then taxable = net − share; tax = taxable × taxRate; lineTotal = taxable + tax.
 */
export function calculateInvoice(input: CalcInput): CalcResult {
  const headerPct = dec(input.headerDiscountPct);

  const base = input.lines.map((line) => {
    const lineGross = roundMoney(dec(line.quantity).times(line.unitPrice));
    const lineDiscount = roundMoney(lineGross.times(line.lineDiscountPct).dividedBy(HUNDRED));
    const lineNet = lineGross.minus(lineDiscount);
    return { lineGross, lineDiscount, lineNet, taxRate: dec(line.taxRate) };
  });

  const netSum = base.reduce((acc, l) => acc.plus(l.lineNet), ZERO);
  const headerTotal = roundMoney(netSum.times(headerPct).dividedBy(HUNDRED));

  const shares: Dec[] = base.map((l) => roundMoney(l.lineNet.times(headerPct).dividedBy(HUNDRED)));
  const remainder = headerTotal.minus(shares.reduce((acc, s) => acc.plus(s), ZERO));
  if (!remainder.isZero() && base.length > 0) {
    let largest = 0;
    base.forEach((l, i) => {
      if (l.lineNet.greaterThan(base[largest]!.lineNet)) largest = i;
    });
    shares[largest] = shares[largest]!.plus(remainder);
  }

  const lines = base.map((l, i) => {
    const share = shares[i]!;
    const taxable = l.lineNet.minus(share);
    const tax = roundMoney(taxable.times(l.taxRate));
    return {
      lineGross: l.lineGross,
      lineDiscount: l.lineDiscount,
      headerDiscountShare: share,
      taxableAmount: taxable,
      taxAmount: tax,
      lineTotal: taxable.plus(tax),
    };
  });

  const sum = (pick: (l: (typeof lines)[number]) => Dec): Dec =>
    lines.reduce((acc, l) => acc.plus(pick(l)), ZERO);

  return {
    lines: lines.map((l) => ({
      lineGross: l.lineGross.toFixed(2),
      lineDiscount: l.lineDiscount.toFixed(2),
      headerDiscountShare: l.headerDiscountShare.toFixed(2),
      taxableAmount: l.taxableAmount.toFixed(2),
      taxAmount: l.taxAmount.toFixed(2),
      lineTotal: l.lineTotal.toFixed(2),
    })),
    subtotal: sum((l) => l.lineGross).toFixed(2),
    discountTotal: sum((l) => l.lineDiscount.plus(l.headerDiscountShare)).toFixed(2),
    taxableTotal: sum((l) => l.taxableAmount).toFixed(2),
    taxTotal: sum((l) => l.taxAmount).toFixed(2),
    grandTotal: sum((l) => l.lineTotal).toFixed(2),
  };
}
