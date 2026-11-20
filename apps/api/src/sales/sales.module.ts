import { Module } from '@nestjs/common';
import { InvoicesController } from './invoices/invoices.controller.js';
import { InvoicesService } from './invoices/invoices.service.js';
import { LookupsController } from './lookups.controller.js';

@Module({
  controllers: [LookupsController, InvoicesController],
  providers: [InvoicesService],
})
export class SalesModule {}
