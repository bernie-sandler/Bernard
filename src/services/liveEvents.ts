import { EventEmitter } from 'node:events';
import type { LogType } from '../config/settings.js';

/**
 * Coarse "something changed" signals for the dashboard's live updates. Topics carry no data: the
 * dashboard refetches through the normal permission-checked endpoints, so nothing leaks over the
 * event stream.
 */
export type LiveTopic =
  | LogType // a log entry of this type was written (members, moderation, voice, ...)
  | 'tempVoice' // a temporary voice channel was created/deleted or someone joined/left one
  | 'tiers' // tier configuration changed or a sync finished
  | 'hubs' // voice hub configuration changed
  | 'settings'
  | 'permissions'
  | 'status' // the status page was read from Uptime Kuma
  | 'rolePanels'; // a self-assign role panel was created, changed, posted or deleted

export const LIVE_TOPICS: readonly LiveTopic[] = [
  'moderation',
  'members',
  'messages',
  'voice',
  'server',
  'commands',
  'tempVoice',
  'tiers',
  'hubs',
  'settings',
  'permissions',
  'status',
  'rolePanels',
];

/** Map an audit action ("permissions.set", "tiers.add", ...) to the topic it changes. */
export function topicForAudit(action: string): LiveTopic | null {
  if (action.startsWith('permissions.')) return 'permissions';
  if (action.startsWith('tiers.') || action.startsWith('settings.tiers')) return 'tiers';
  if (action.startsWith('voice.hub.')) return 'hubs';
  if (action.startsWith('rolePanels.')) return 'rolePanels';
  if (action.startsWith('settings.')) return 'settings';
  return null;
}

export class LiveEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One listener per open dashboard tab.
    this.emitter.setMaxListeners(200);
  }

  publish(topic: LiveTopic): void {
    this.emitter.emit('topic', topic);
  }

  subscribe(listener: (topic: LiveTopic) => void): () => void {
    this.emitter.on('topic', listener);
    return () => this.emitter.off('topic', listener);
  }

  get listenerCount(): number {
    return this.emitter.listenerCount('topic');
  }
}
