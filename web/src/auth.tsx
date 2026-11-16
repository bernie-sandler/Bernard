import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { Navigate } from 'react-router';
import type { MeResponse } from '../../src/shared/api.js';
import { ApiError, api, setCsrfToken } from './api.js';
import { Button, FullPageSpinner } from './components/ui.js';

interface AuthContextValue {
  me: MeResponse;
  can: (node: string) => boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside RequireAuth');
  return ctx;
}

/** Loads the current user; redirects to /login when there is no session. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const data = await api<MeResponse>('/auth/me');
      setCsrfToken(data.csrfToken);
      return data;
    },
    retry: false,
    staleTime: 60_000,
  });

  const value = useMemo<AuthContextValue | null>(() => {
    if (!me.data) return null;
    const allowed = new Set(me.data.allowedNodes);
    return {
      me: me.data,
      can: (node) => allowed.has(node),
      logout: async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => {});
        setCsrfToken(null);
        queryClient.clear();
        window.location.assign('/login');
      },
    };
  }, [me.data, queryClient]);

  if (me.isPending) return <FullPageSpinner />;
  if (me.error) {
    if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/login" replace />;
    if (me.error instanceof ApiError && me.error.status === 403) return <NoAccess />;
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <div>
          <p className="text-lg font-semibold">Couldn't reach the dashboard API</p>
          <p className="mt-1 text-sm text-slate-400">{me.error.message}</p>
          <Button className="mt-4" onClick={() => me.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function NoAccess() {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <div className="max-w-sm">
        <p className="text-lg font-semibold">No dashboard access</p>
        <p className="mt-2 text-sm text-slate-400">
          Your roles no longer grant <code className="text-slate-300">dashboard:access</code>. Ask an admin,
          then log in again.
        </p>
        <Button
          className="mt-4"
          onClick={async () => {
            await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
            window.location.assign('/login');
          }}
        >
          Log out
        </Button>
      </div>
    </div>
  );
}
