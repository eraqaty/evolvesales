import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { LoginPage } from './auth/LoginPage';
import { ChangeRequestDetailPage } from './features/change-requests/ChangeRequestDetailPage';
import { ChangeRequestListPage } from './features/change-requests/ChangeRequestListPage';
import { InvoiceDetailsPage } from './features/invoices/InvoiceDetailsPage';
import { InvoiceEditorPage } from './features/invoices/InvoiceEditorPage';
import { InvoiceListPage } from './features/invoices/InvoiceListPage';
import { AgentAdminPage } from './features/admin/AgentAdminPage';
import { ProfilePage } from './features/profile/ProfilePage';
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
      { path: 'requests', element: <ChangeRequestListPage mode="requests" /> },
      { path: 'requests/:id', element: <ChangeRequestDetailPage /> },
      { path: 'approvals', element: <ChangeRequestListPage mode="approvals" /> },
      { path: 'profile', element: <ProfilePage /> },
      { path: 'admin/agents', element: <AgentAdminPage /> },
      { path: '*', element: <Navigate to="/invoices" replace /> },
    ],
  },
];

const router = createBrowserRouter(routes);

export function App() {
  return <RouterProvider router={router} />;
}
