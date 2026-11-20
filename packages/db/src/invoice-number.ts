import { formatInvoiceNumber } from '@evolvesales/shared';
import type { Prisma } from './generated/client.js';

/**
 * Allocate the next invoice number for `year`. Must run inside the transaction that inserts the
 * invoice: the row lock taken by INSERT … ON CONFLICT DO UPDATE serialises concurrent callers, and
 * a rollback releases the number (so no gaps are created by failed inserts).
 */
export async function allocateInvoiceNumber(
  tx: Prisma.TransactionClient,
  year: number,
): Promise<string> {
  const rows = await tx.$queryRaw<{ last_value: number }[]>`
    INSERT INTO "invoice_sequences" ("year", "last_value")
    VALUES (${year}, 1)
    ON CONFLICT ("year") DO UPDATE SET "last_value" = "invoice_sequences"."last_value" + 1
    RETURNING "last_value"`;
  const value = rows[0]?.last_value;
  if (value === undefined) {
    throw new Error('Invoice sequence allocation returned no row');
  }
  return formatInvoiceNumber(year, value);
}
