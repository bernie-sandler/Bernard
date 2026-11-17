import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { ApiError } from './api.js';
import { RequireAuth } from './auth.js';
import { Layout } from './components/Layout.js';
import { ToastProvider } from './components/ui.js';
import './index.css';
import { LoginPage } from './pages/Login.js';
import { NotFoundPage } from './pages/NotFound.js';

// Pages load on demand so the charting library isn't in the initial bundle.
const OverviewPage = lazy(() => import('./pages/Overview.js').then((m) => ({ default: m.OverviewPage })));
const MembersPage = lazy(() => import('./pages/Members.js').then((m) => ({ default: m.MembersPage })));
const MemberDetailPage = lazy(() =>
  import('./pages/MemberDetail.js').then((m) => ({ default: m.MemberDetailPage })),
);
const ModerationPage = lazy(() =>
  import('./pages/Moderation.js').then((m) => ({ default: m.ModerationPage })),
);
const LogsPage = lazy(() => import('./pages/Logs.js').then((m) => ({ default: m.LogsPage })));
const CommandRunnerPage = lazy(() =>
  import('./pages/CommandRunner.js').then((m) => ({ default: m.CommandRunnerPage })),
);
const PermissionsPage = lazy(() =>
  import('./pages/Permissions.js').then((m) => ({ default: m.PermissionsPage })),
);
const TiersPage = lazy(() => import('./pages/Tiers.js').then((m) => ({ default: m.TiersPage })));
const VoicePage = lazy(() => import('./pages/Voice.js').then((m) => ({ default: m.VoicePage })));
const StatusPage = lazy(() => import('./pages/Status.js').then((m) => ({ default: m.StatusPage })));
const RolePanelsPage = lazy(() =>
  import('./pages/RolePanels.js').then((m) => ({ default: m.RolePanelsPage })),
);
const ReportsPage = lazy(() => import('./pages/Reports.js').then((m) => ({ default: m.ReportsPage })));
const SettingsPage = lazy(() => import('./pages/Settings.js').then((m) => ({ default: m.SettingsPage })));
const AuditPage = lazy(() => import('./pages/Audit.js').then((m) => ({ default: m.AuditPage })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // Retry only transient server errors, never auth/permission/validation errors.
      retry: (count, err) => err instanceof ApiError && err.status >= 500 && count < 2,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              element={
                <RequireAuth>
                  <Layout />
                </RequireAuth>
              }
            >
              <Route index element={<OverviewPage />} />
              <Route path="members" element={<MembersPage />} />
              <Route path="members/:id" element={<MemberDetailPage />} />
              <Route path="moderation" element={<ModerationPage />} />
              <Route path="logs" element={<LogsPage />} />
              <Route path="commands" element={<CommandRunnerPage />} />
              <Route path="permissions" element={<PermissionsPage />} />
              <Route path="tiers" element={<TiersPage />} />
              <Route path="voice" element={<VoicePage />} />
              <Route path="status" element={<StatusPage />} />
              <Route path="reports" element={<ReportsPage />} />
              <Route path="role-panels" element={<RolePanelsPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="audit" element={<AuditPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
