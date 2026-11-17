import { Suspense, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../auth.js';
import { type LiveStatus, useLiveUpdates } from '../live.js';
import { Avatar, Button, cx, FullPageSpinner } from './ui.js';

interface NavItem {
  to: string;
  label: string;
  /** Shown when the user has any of these nodes (always shown when omitted). */
  nodes?: string[];
  icon: string;
  /** Start a new group in the sidebar. */
  section?: string;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: 'M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10' },
  { to: '/members', label: 'Members', icon: 'M16 11a4 4 0 1 0-8 0M4 20a8 8 0 0 1 16 0' },
  {
    to: '/moderation',
    label: 'Moderation',
    nodes: ['admin:case'],
    icon: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z',
  },
  { to: '/logs', label: 'Logs', nodes: ['dashboard:logs'], icon: 'M5 4h14v16H5zM9 8h6M9 12h6M9 16h4' },
  { to: '/commands', label: 'Command Runner', icon: 'M4 17l6-5-6-5M12 19h8', section: 'Manage' },
  {
    to: '/permissions',
    label: 'Permissions',
    nodes: ['config:permlist'],
    icon: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  },
  { to: '/tiers', label: 'Tiers', nodes: ['config:tiers'], icon: 'M4 20h16M6 16h12M8 12h8M10 8h4M12 4v0' },
  {
    to: '/voice',
    label: 'Voice hubs',
    nodes: ['config:voice'],
    icon: 'M11 5L6 9H3v6h3l5 4V5zM15.5 8.5a5 5 0 0 1 0 7',
  },
  {
    to: '/status',
    label: 'Status',
    nodes: ['config:status'],
    icon: 'M3 12h4l3-8 4 16 3-8h4',
  },
  {
    to: '/role-panels',
    label: 'Role panels',
    nodes: ['config:rolepanels'],
    icon: 'M20 12l-8 8-9-9V3h8l9 9zM7.5 7.5h.01',
  },
  {
    to: '/reports',
    label: 'Issue reports',
    nodes: ['config:belltower'],
    icon: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0',
  },
  {
    to: '/settings',
    label: 'Settings',
    nodes: ['config:logs', 'config:activity', 'config:settings', 'config:voice', 'config:tiers'],
    icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-2-4-2 1-2-2V4h-4v2l-2 2-2-1-2 4 2 1v0l-2 1 2 4 2-1 2 2v2h4v-2l2-2 2 1 2-4-2-1z',
  },
  {
    to: '/audit',
    label: 'Audit log',
    nodes: ['dashboard:audit'],
    icon: 'M12 8v4l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  },
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

const LIVE_LABELS: Record<LiveStatus, { text: string; dot: string; title: string }> = {
  live: { text: 'Live', dot: 'bg-emerald-400', title: 'Updates appear as they happen' },
  connecting: {
    text: 'Reconnecting…',
    dot: 'bg-amber-400 animate-pulse',
    title: 'Trying to reconnect for live updates',
  },
  offline: { text: 'Offline: reload for updates', dot: 'bg-slate-500', title: 'Live updates stopped' },
};

function LiveBadge({ status }: { status: LiveStatus }) {
  const l = LIVE_LABELS[status];
  return (
    <div className="flex items-center gap-1.5 text-xs text-slate-500" title={l.title} aria-live="polite">
      <span className={cx('size-1.5 rounded-full', l.dot)} aria-hidden />
      {l.text}
    </div>
  );
}

export function Layout() {
  const { me, can, logout } = useAuth();
  const live = useLiveUpdates();
  const [open, setOpen] = useState(false);
  const items = NAV.filter((n) => !n.nodes || n.nodes.some(can));

  const nav = (
    <nav className="flex flex-1 flex-col gap-1 overflow-y-auto">
      {items.map((n) => [
        n.section && (
          <div
            key={`${n.to}-section`}
            className="mt-4 mb-1 px-3 text-xs font-semibold tracking-wide text-slate-500 uppercase"
          >
            {n.section}
          </div>
        ),
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
        </NavLink>,
      ])}
    </nav>
  );

  const sidebar = (
    <div className="flex h-full flex-col gap-6 p-4">
      <div className="flex items-center gap-3 px-1">
        <Avatar url={me.guild.iconUrl} name={me.guild.name} size={36} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-50">{me.guild.name}</div>
          <LiveBadge status={live} />
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
