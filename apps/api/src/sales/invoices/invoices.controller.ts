import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  type CancelInvoiceInput,
  cancelInvoiceSchema,
  type ConfirmInvoiceInput,
  confirmInvoiceSchema,
  type CreateInvoiceInput,
  createInvoiceSchema,
  type InvoiceDetailDto,
  type InvoiceSummaryDto,
  type ListInvoicesQuery,
  listInvoicesQuerySchema,
  type Page,
  Role,
  type UpdateInvoiceInput,
  updateInvoiceSchema,
} from '@evolvesales/shared';
import { z } from 'zod';
import type { AuthUser } from '../../auth/auth.types.js';
import { CurrentUser, Roles } from '../../auth/decorators.js';
import { ReqCtx, type RequestContext } from '../../common/request-context.js';
import { InvoicesService } from './invoices.service.js';

const idParam = { schema: z.uuid() };

@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  /** Any signed-in user may read invoices. */
  @Get()
  list(
    @Query({ schema: listInvoicesQuerySchema }) q: ListInvoicesQuery,
  ): Promise<Page<InvoiceSummaryDto>> {
    return this.invoices.list(q);
  }

  @Get(':id')
  get(@Param('id', idParam) id: string): Promise<InvoiceDetailDto> {
    return this.invoices.get(id);
  }

  @Post()
  @Roles(Role.SalesUser, Role.SalesManager)
  create(
    @Body({ schema: createInvoiceSchema }) body: CreateInvoiceInput,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<InvoiceDetailDto> {
    return this.invoices.create(body, user, ctx);
  }

  @Put(':id')
  @Roles(Role.SalesUser, Role.SalesManager)
  update(
    @Param('id', idParam) id: string,
    @Body({ schema: updateInvoiceSchema }) body: UpdateInvoiceInput,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<InvoiceDetailDto> {
    return this.invoices.update(id, body, user, ctx);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @Roles(Role.SalesUser, Role.SalesManager)
  confirm(
    @Param('id', idParam) id: string,
    @Body({ schema: confirmInvoiceSchema }) body: ConfirmInvoiceInput,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<InvoiceDetailDto> {
    return this.invoices.confirm(id, body.version, user, ctx);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Roles(Role.SalesUser, Role.SalesManager)
  cancel(
    @Param('id', idParam) id: string,
    @Body({ schema: cancelInvoiceSchema }) body: CancelInvoiceInput,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<InvoiceDetailDto> {
    return this.invoices.cancel(id, body, user, ctx);
  }
}
