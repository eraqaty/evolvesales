import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { LoginPage } from './auth/LoginPage';
import { InvoiceDetailsPage } from './features/invoices/InvoiceDetailsPage';
import { InvoiceEditorPage } from './features/invoices/InvoiceEditorPage';
import { InvoiceListPage } from './features/invoices/InvoiceListPage';
import { AppLayout } from './layout/AppLayout';

export const routes = [
  { path: '/login', element: <LoginPage /> },
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/invoices" replace /> },
      { path: 'invoices', element: <InvoiceListPage /> },
      { path: 'invoices/new', element: <InvoiceEditorPage /> },
      { path: 'invoices/:id', element: <InvoiceDetailsPage /> },
      { path: 'invoices/:id/edit', element: <InvoiceEditorPage /> },
      { path: '*', element: <Navigate to="/invoices" replace /> },
    ],
  },
];

const router = createBrowserRouter(routes);

export function App() {
  return <RouterProvider router={router} />;
}
