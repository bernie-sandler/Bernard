import { Link } from 'react-router';
import type { CaseDto, Mentions } from '../../../src/shared/api.js';
import { dateTime, duration, relativeTime } from '../format.js';
import { RichText } from './RichText.js';
import { Badge, type BadgeTone, EmptyState } from './ui.js';

const TONES: Record<string, BadgeTone> = {
  ban: 'red',
  kick: 'orange',
  timeout: 'yellow',
  warn: 'yellow',
  unban: 'green',
  untimeout: 'green',
  unlock: 'green',
  lock: 'yellow',
};

export function CaseActionBadge({ c }: { c: Pick<CaseDto, 'action' | 'label' | 'active'> }) {
  return (
    <Badge tone={TONES[c.action] ?? 'blue'}>
      {c.label}
      {c.action === 'warn' && !c.active && ' (removed)'}
    </Badge>
  );
}

function Target({ c }: { c: CaseDto }) {
  if (c.targetType === 'channel')
    return <span className="text-slate-300">#{c.targetName ?? c.targetId}</span>;
  return (
    <Link to={`/members/${c.targetId}`} className="text-slate-200 hover:text-indigo-300 hover:underline">
      {c.targetName ?? c.targetId}
    </Link>
  );
}

export function CaseTable({
  cases,
  mentions,
  compact,
}: {
  cases: CaseDto[];
  mentions?: Mentions;
  compact?: boolean;
}) {
  if (cases.length === 0) return <EmptyState>No cases yet.</EmptyState>;
  return (
    <div className="-mx-4 overflow-x-auto sm:mx-0">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="text-xs text-slate-500 uppercase">
          <tr className="border-b border-slate-800">
            <th className="px-3 py-2 font-medium">Case</th>
            <th className="px-3 py-2 font-medium">Action</th>
            <th className="px-3 py-2 font-medium">Target</th>
            {!compact && <th className="px-3 py-2 font-medium">Moderator</th>}
            <th className="px-3 py-2 font-medium">Reason</th>
            {!compact && <th className="px-3 py-2 font-medium">Source</th>}
            <th className="px-3 py-2 font-medium">When</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.caseNumber} className="border-b border-slate-800/60 align-top last:border-0">
              <td className="px-3 py-2 font-mono text-slate-400">#{c.caseNumber}</td>
              <td className="px-3 py-2">
                <CaseActionBadge c={c} />
                {c.durationMs ? (
                  <div className="mt-1 text-xs text-slate-500">{duration(c.durationMs)}</div>
                ) : null}
              </td>
              <td className="px-3 py-2">
                <Target c={c} />
              </td>
              {!compact && (
                <td className="px-3 py-2 text-slate-300">
                  {c.source === 'system' ? (
                    'System'
                  ) : (
                    <Link to={`/members/${c.moderatorId}`} className="hover:underline">
                      {c.moderatorName ?? c.moderatorId}
                    </Link>
                  )}
                </td>
              )}
              <td className="max-w-xs min-w-48 px-3 py-2 text-slate-300">
                {c.reason ? (
                  <RichText text={c.reason} {...(mentions ? { mentions } : {})} />
                ) : (
                  <span className="text-slate-600">—</span>
                )}
                {c.action === 'role_add' || c.action === 'role_remove' ? (
                  <div className="text-xs text-slate-500">
                    Role: {String(c.data?.roleName ?? c.data?.roleId ?? '')}
                  </div>
                ) : null}
                {c.action === 'purge' ? (
                  <div className="text-xs text-slate-500">
                    {String(c.data?.deleted ?? 0)} deleted · {String(c.data?.skippedOld ?? 0)} too old
                  </div>
                ) : null}
              </td>
              {!compact && (
                <td className="px-3 py-2">
                  <Badge>{c.source}</Badge>
                </td>
              )}
              <td className="px-3 py-2 whitespace-nowrap text-slate-400" title={dateTime(c.createdAt)}>
                {relativeTime(c.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
