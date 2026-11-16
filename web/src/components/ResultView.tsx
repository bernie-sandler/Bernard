import type { Mentions, RunCommandResponse } from '../../../src/shared/api.js';
import { RichText } from './RichText.js';
import { cx } from './ui.js';

const hex = (c?: number) => (c === undefined ? '#5865f2' : `#${c.toString(16).padStart(6, '0')}`);

/** Render a command's reply the way Discord would: text plus embeds. */
export function ResultView({
  result,
  mentions,
}: {
  result: RunCommandResponse['result'];
  mentions: Mentions;
}) {
  return (
    <div className="space-y-3">
      {result.content && (
        <p className={cx('text-sm whitespace-pre-wrap', result.ok ? 'text-slate-100' : 'text-red-200')}>
          <RichText text={result.content} mentions={mentions} />
        </p>
      )}
      {(result.embeds ?? []).map((e, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: embeds have no identity and never reorder
          key={i}
          className="rounded-md border border-slate-800 bg-slate-950/70 p-3 text-sm"
          style={{ borderLeft: `4px solid ${hex(e.color)}` }}
        >
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              {e.title && <div className="font-semibold text-slate-50">{e.title}</div>}
              {e.description && (
                <div className="mt-1 whitespace-pre-wrap text-slate-300">
                  <RichText text={e.description} mentions={mentions} />
                </div>
              )}
              {e.fields && e.fields.length > 0 && (
                <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-3">
                  {e.fields.map((f, j) => (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: fields can repeat names
                      key={j}
                      className={f.inline ? '' : 'sm:col-span-3'}
                    >
                      <dt className="text-xs font-semibold text-slate-400">{f.name}</dt>
                      <dd className="whitespace-pre-wrap text-slate-200">
                        <RichText text={f.value} mentions={mentions} />
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {e.footer && <div className="mt-2 text-xs text-slate-500">{e.footer}</div>}
            </div>
            {e.thumbnailUrl && <img src={e.thumbnailUrl} alt="" className="size-14 shrink-0 rounded" />}
          </div>
        </div>
      ))}
    </div>
  );
}
