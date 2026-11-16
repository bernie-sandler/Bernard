import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { Mentions } from '../../../src/shared/api.js';
import { roleColor } from '../format.js';

const TOKEN = /<(@!?|@&|#)(\d{17,20})>|<t:(\d+):[a-zA-Z]>|\*\*(.+?)\*\*|`([^`]+)`/g;

/**
 * Render Discord-flavoured text from logs and cases: user/role/channel mentions, timestamps,
 * **bold** and `code`. Everything else is plain text (no HTML injection).
 */
export function RichText({ text, mentions }: { text: string; mentions?: Mentions }) {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = i++;
    const [, kind, id, unix, bold, code] = m;
    if (kind && id) {
      if (kind === '@&') {
        const role = mentions?.roles[id];
        out.push(
          <span
            key={key}
            className="rounded px-1 font-medium"
            style={{
              color: roleColor(role?.color ?? 0),
              backgroundColor: `${roleColor(role?.color ?? 0)}22`,
            }}
          >
            @{role?.name ?? 'unknown-role'}
          </span>,
        );
      } else if (kind === '#') {
        out.push(
          <span key={key} className="rounded bg-slate-800 px-1 font-medium text-slate-200">
            #{mentions?.channels[id] ?? 'deleted-channel'}
          </span>,
        );
      } else {
        out.push(
          <Link
            key={key}
            to={`/members/${id}`}
            className="rounded bg-blurple/20 px-1 font-medium text-indigo-200 hover:bg-blurple/30"
          >
            @{mentions?.users[id] ?? id}
          </Link>,
        );
      }
    } else if (unix) {
      out.push(<time key={key}>{new Date(Number(unix) * 1000).toLocaleString()}</time>);
    } else if (bold) {
      out.push(<strong key={key}>{bold}</strong>);
    } else if (code) {
      out.push(
        <code key={key} className="rounded bg-slate-800 px-1 text-[0.85em]">
          {code}
        </code>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
