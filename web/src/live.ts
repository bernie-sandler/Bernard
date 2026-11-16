import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

export type LiveStatus = 'connecting' | 'live' | 'offline';

/** Which cached queries each server topic makes stale (see src/services/liveEvents.ts). */
const INVALIDATES: Record<string, string[][]> = {
  members: [['overview'], ['members'], ['member'], ['logs']],
  moderation: [['overview'], ['cases'], ['member'], ['members'], ['logs'], ['audit']],
  messages: [['logs']],
  voice: [['logs']],
  server: [['logs']],
  commands: [['logs'], ['audit']],
  tempVoice: [['overview'], ['voice']],
  tiers: [['tiers'], ['settings'], ['overview'], ['members'], ['member'], ['audit']],
  hubs: [['voice'], ['audit']],
  settings: [['settings'], ['audit']],
  permissions: [['permissions'], ['me'], ['commands'], ['audit']],
};

/**
 * Keep the dashboard fresh from the server's event stream. The stream only says *what* changed;
 * queries refetch through the normal API. After a reconnect everything is refreshed, since events
 * may have been missed while offline.
 */
export function useLiveUpdates(): LiveStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('connecting');

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      setStatus('offline');
      return;
    }
    const source = new EventSource('/api/events');
    let hadError = false;

    source.addEventListener('ready', () => {
      setStatus('live');
      if (hadError) void queryClient.invalidateQueries();
      hadError = false;
    });
    source.onmessage = (e) => {
      try {
        const { topics } = JSON.parse(e.data) as { topics: string[] };
        const keys = new Map<string, string[]>();
        for (const t of topics) for (const k of INVALIDATES[t] ?? []) keys.set(k.join('/'), k);
        for (const k of keys.values()) void queryClient.invalidateQueries({ queryKey: k });
      } catch {
        // Ignore malformed messages.
      }
    };
    source.onerror = () => {
      hadError = true;
      // CLOSED means the browser gave up (e.g. the session ended); otherwise it is retrying.
      setStatus(source.readyState === EventSource.CLOSED ? 'offline' : 'connecting');
    };
    return () => source.close();
  }, [queryClient]);

  return status;
}
