import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

export * from './generated/client.js';
export { allocateInvoiceNumber } from './invoice-number.js';

/** Create a Prisma client over node-postgres. Use one instance per process. */
export function createPrismaClient(connectionString: string): PrismaClient {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
