import { Suspense, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../auth.js';
import { Avatar, Button, cx, FullPageSpinner } from './ui.js';

interface NavItem {
  to: string;
  label: string;
  node?: string;
  icon: string;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: 'M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10' },
  { to: '/members', label: 'Members', icon: 'M16 11a4 4 0 1 0-8 0M4 20a8 8 0 0 1 16 0' },
  {
    to: '/moderation',
    label: 'Moderation',
    node: 'admin:case',
    icon: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z',
  },
  { to: '/logs', label: 'Logs', node: 'dashboard:logs', icon: 'M5 4h14v16H5zM9 8h6M9 12h6M9 16h4' },
];

function Icon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-4.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

export function Layout() {
  const { me, can, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const items = NAV.filter((n) => !n.node || can(n.node));

  const nav = (
    <nav className="flex flex-1 flex-col gap-1">
      {items.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.to === '/'}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            cx(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-slate-800 text-white'
                : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200',
            )
          }
        >
          <Icon d={n.icon} />
          {n.label}
        </NavLink>
      ))}
    </nav>
  );

  const sidebar = (
    <div className="flex h-full flex-col gap-6 p-4">
      <div className="flex items-center gap-3 px-1">
        <Avatar url={me.guild.iconUrl} name={me.guild.name} size={36} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-50">{me.guild.name}</div>
          <div className="text-xs text-slate-500">Bernard dashboard</div>
        </div>
      </div>
      {nav}
      <div className="flex items-center gap-3 rounded-lg border border-slate-800 p-2">
        <Avatar url={me.user.avatarUrl} name={me.user.displayName} size={32} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{me.user.displayName}</div>
          <div className="truncate text-xs text-slate-500">@{me.user.username}</div>
        </div>
        <Button size="sm" variant="ghost" onClick={logout} title="Log out">
          Log out
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 border-r border-slate-800 bg-slate-900/40 lg:block">
        {sidebar}
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/60"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-72 border-r border-slate-800 bg-slate-900">
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-slate-800 px-4 py-3 lg:hidden">
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label="Open menu">
            <Icon d="M4 6h16M4 12h16M4 18h16" />
          </Button>
          <span className="truncate text-sm font-semibold">{me.guild.name}</span>
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl p-4 sm:p-6">
            <Suspense fallback={<FullPageSpinner />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold text-slate-50">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}
