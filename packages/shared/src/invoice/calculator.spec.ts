import { describe, expect, it } from 'vitest';
import { dec } from '../money.js';
import { calculateInvoice } from './calculator.js';

describe('calculateInvoice', () => {
  it('returns zeros for an invoice without lines', () => {
    const r = calculateInvoice({ headerDiscountPct: 10, lines: [] });
    expect(r).toMatchObject({
      subtotal: '0.00',
      discountTotal: '0.00',
      taxTotal: '0.00',
      grandTotal: '0.00',
      lines: [],
    });
  });

  it('computes a single line with line discount and 14 % tax', () => {
    // 3 × 100 = 300; 10 % off = 30; taxable 270; tax 37.80; total 307.80
    const r = calculateInvoice({
      headerDiscountPct: 0,
      lines: [{ quantity: 3, unitPrice: '100.00', lineDiscountPct: 10, taxRate: '0.14' }],
    });
    expect(r.lines[0]).toEqual({
      lineGross: '300.00',
      lineDiscount: '30.00',
      headerDiscountShare: '0.00',
      taxableAmount: '270.00',
      taxAmount: '37.80',
      lineTotal: '307.80',
    });
    expect(r.grandTotal).toBe('307.80');
  });

  it('applies the header discount after line discounts and before tax', () => {
    // line1 net 200 (14 %), line2 net 100 (0 %); header 10 % → shares 20 / 10
    const r = calculateInvoice({
      headerDiscountPct: 10,
      lines: [
        { quantity: 2, unitPrice: 100, lineDiscountPct: 0, taxRate: 0.14 },
        { quantity: 1, unitPrice: 100, lineDiscountPct: 0, taxRate: 0 },
      ],
    });
    expect(r.lines.map((l) => l.headerDiscountShare)).toEqual(['20.00', '10.00']);
    expect(r.lines.map((l) => l.taxAmount)).toEqual(['25.20', '0.00']);
    expect(r).toMatchObject({
      subtotal: '300.00',
      discountTotal: '30.00',
      taxableTotal: '270.00',
      taxTotal: '25.20',
      grandTotal: '295.20',
    });
  });

  it('puts the header-discount rounding remainder on the largest line so totals reconcile', () => {
    // 33.333 % on 1.00 / 1.01 / 1.00: per-line shares 0.33 each = 0.99,
    // invoice level round(3.01 × 33.333 %) = 1.00 → the +0.01 remainder goes to the 1.01 line
    const r = calculateInvoice({
      headerDiscountPct: '33.333',
      lines: [
        { quantity: 1, unitPrice: '1.00', lineDiscountPct: 0, taxRate: 0 },
        { quantity: 1, unitPrice: '1.01', lineDiscountPct: 0, taxRate: 0 },
        { quantity: 1, unitPrice: '1.00', lineDiscountPct: 0, taxRate: 0 },
      ],
    });
    const shares = r.lines.map((l) => dec(l.headerDiscountShare));
    const shareSum = shares.reduce((a, b) => a.plus(b), dec(0));
    // invoice-level: 3.01 × 33.333 % = 1.0033 → 1.00
    expect(shareSum.toFixed(2)).toBe('1.00');
    expect(r.lines[1]!.headerDiscountShare).toBe('0.34'); // the largest line absorbs +0.01
    expect(r.discountTotal).toBe('1.00');
  });

  it('supports fractional quantities and half-up rounding', () => {
    // 1.255 × 2.00 = 2.51; tax 14 % = 0.3514 → 0.35
    const r = calculateInvoice({
      headerDiscountPct: 0,
      lines: [{ quantity: '1.255', unitPrice: '2.00', lineDiscountPct: 0, taxRate: '0.14' }],
    });
    expect(r.lines[0]!.lineGross).toBe('2.51');
    expect(r.lines[0]!.taxAmount).toBe('0.35');
    expect(r.grandTotal).toBe('2.86');
  });

  it('handles 100 % discount without negative amounts', () => {
    const r = calculateInvoice({
      headerDiscountPct: 50,
      lines: [{ quantity: 1, unitPrice: 99.99, lineDiscountPct: 100, taxRate: 0.14 }],
    });
    expect(r.lines[0]).toMatchObject({
      taxableAmount: '0.00',
      taxAmount: '0.00',
      lineTotal: '0.00',
    });
    expect(r.grandTotal).toBe('0.00');
  });

  it('keeps grand total = taxable total + tax total', () => {
    const r = calculateInvoice({
      headerDiscountPct: '7.5',
      lines: [
        { quantity: '3.5', unitPrice: '19.99', lineDiscountPct: '2.5', taxRate: '0.14' },
        { quantity: 7, unitPrice: '4.35', lineDiscountPct: 0, taxRate: '0.05' },
        { quantity: 1, unitPrice: '1250.00', lineDiscountPct: 15, taxRate: 0 },
      ],
    });
    expect(dec(r.taxableTotal).plus(r.taxTotal).toFixed(2)).toBe(r.grandTotal);
    expect(dec(r.subtotal).minus(r.discountTotal).toFixed(2)).toBe(r.taxableTotal);
  });
});
