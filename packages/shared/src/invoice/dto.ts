import type { InvoiceStatus } from './schemas.js';

/** API response shapes. Money and quantities are decimal strings; dates are YYYY-MM-DD. */

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CustomerRef {
  id: string;
  code: string;
  name: string;
}

export interface UserRef {
  id: string;
  displayName: string;
}

export interface InvoiceSummaryDto {
  id: string;
  number: string;
  status: InvoiceStatus;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  customer: CustomerRef;
  grandTotal: string;
  createdAt: string;
}

export interface InvoiceItemDto {
  id: string;
  lineNo: number;
  product: { id: string; sku: string; name: string; unit: string };
  description: string | null;
  quantity: string;
  unitPrice: string;
  lineDiscountPct: string;
  taxRate: string;
  lineGross: string;
  lineDiscount: string;
  headerDiscountShare: string;
  taxableAmount: string;
  taxAmount: string;
  lineTotal: string;
}

export interface InvoiceDetailDto extends InvoiceSummaryDto {
  headerDiscountPct: string;
  subtotal: string;
  discountTotal: string;
  taxableTotal: string;
  taxTotal: string;
  notes: string | null;
  version: number;
  items: InvoiceItemDto[];
  createdBy: UserRef;
  confirmedBy: UserRef | null;
  confirmedAt: string | null;
  cancelledBy: UserRef | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  updatedAt: string;
}
