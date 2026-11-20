import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateInvoiceInput,
  InvoiceDetailDto,
  InvoiceStatus,
  InvoiceSummaryDto,
  Page,
  UpdateInvoiceInput,
} from '@evolvesales/shared';
import { http, toQuery } from '../../lib/api';

export interface CustomerOption {
  id: string;
  code: string;
  name: string;
}

export interface ProductOption {
  id: string;
  sku: string;
  name: string;
  unit: string;
  unitPrice: string;
  taxRate: string;
}

export interface InvoiceFilters {
  search?: string;
  status?: InvoiceStatus;
  customerId?: string;
  dateFrom?: string;
  dateTo?: string;
  page: number;
  pageSize: number;
}

/** Request bodies accept numbers or strings for decimals; the API normalises them. */
export type InvoiceBody = Omit<CreateInvoiceInput, 'headerDiscountPct' | 'items'> & {
  headerDiscountPct: string | number;
  items: Array<{
    productId: string;
    description?: string;
    quantity: string | number;
    unitPrice: string | number;
    lineDiscountPct: string | number;
  }>;
};

export const invoiceKeys = {
  all: ['invoices'] as const,
  list: (f: InvoiceFilters) => ['invoices', 'list', f] as const,
  detail: (id: string) => ['invoices', 'detail', id] as const,
};

export function useInvoices(filters: InvoiceFilters) {
  return useQuery({
    queryKey: invoiceKeys.list(filters),
    queryFn: () => http.get<Page<InvoiceSummaryDto>>(`/invoices${toQuery({ ...filters })}`),
    placeholderData: keepPreviousData,
  });
}

export function useInvoice(id: string | undefined) {
  return useQuery({
    queryKey: invoiceKeys.detail(id ?? ''),
    queryFn: () => http.get<InvoiceDetailDto>(`/invoices/${id}`),
    enabled: !!id,
  });
}

export function useCustomers(search: string) {
  return useQuery({
    queryKey: ['customers', search],
    queryFn: () => http.get<CustomerOption[]>(`/customers${toQuery({ search, limit: 50 })}`),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useProducts(search: string) {
  return useQuery({
    queryKey: ['products', search],
    queryFn: () => http.get<ProductOption[]>(`/products${toQuery({ search, limit: 50 })}`),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

function useInvoiceMutation<TVars>(fn: (vars: TVars) => Promise<InvoiceDetailDto>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (invoice) => {
      qc.setQueryData(invoiceKeys.detail(invoice.id), invoice);
      void qc.invalidateQueries({ queryKey: ['invoices', 'list'] });
    },
  });
}

export const useCreateInvoice = () =>
  useInvoiceMutation((body: InvoiceBody) => http.post<InvoiceDetailDto>('/invoices', body));

export const useUpdateInvoice = () =>
  useInvoiceMutation(
    ({ id, body }: { id: string; body: InvoiceBody & Pick<UpdateInvoiceInput, 'version'> }) =>
      http.put<InvoiceDetailDto>(`/invoices/${id}`, body),
  );

export const useConfirmInvoice = () =>
  useInvoiceMutation(({ id, version }: { id: string; version: number }) =>
    http.post<InvoiceDetailDto>(`/invoices/${id}/confirm`, { version }),
  );

export const useCancelInvoice = () =>
  useInvoiceMutation(({ id, version, reason }: { id: string; version: number; reason?: string }) =>
    http.post<InvoiceDetailDto>(`/invoices/${id}/cancel`, { version, reason }),
  );
