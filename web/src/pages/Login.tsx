import { useSearchParams } from 'react-router';

const ERRORS: Record<string, string> = {
  state: 'Your login link expired. Please try again.',
  cancelled: 'Login was cancelled.',
  discord: "Discord didn't complete the login. Please try again.",
  not_member: 'You need to be a member of the server to use the dashboard.',
  forbidden: "You're a member, but your roles don't grant dashboard access (dashboard:access).",
};

export function LoginPage() {
  const [params] = useSearchParams();
  const error = params.get('error');
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/70 p-8 text-center shadow-xl">
        <img src="/logo-256.png" alt="Bernard" width={128} height={128} className="mx-auto size-32" />
        <h1 className="mt-4 text-xl font-semibold text-slate-50">Bernard dashboard</h1>
        <p className="mt-1 text-sm text-slate-400">Sign in with the Discord account you use on the server.</p>
        {error && (
          <p
            role="alert"
            className="mt-5 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200"
          >
            {ERRORS[error] ?? 'Login failed. Please try again.'}
          </p>
        )}
        <a
          href="/api/auth/login"
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-md bg-blurple px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blurple-dark"
        >
          Log in with Discord
        </a>
        <p className="mt-4 text-xs text-slate-500">
          Only your Discord identity is requested (identify scope).
        </p>
      </div>
    </div>
  );
}
