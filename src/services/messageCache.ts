import { LRUCache } from 'lru-cache';

export interface CachedMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorTag: string;
  content: string;
  attachments: { name: string; url: string }[];
  createdAt: number;
}

/**
 * Bounded in-memory cache of recent message content, used only for edit/delete logs.
 * Message content is never written to the database by this cache.
 */
export class MessageCache {
  private lru: LRUCache<string, CachedMessage>;

  constructor(size: number) {
    this.lru = new LRUCache({ max: size });
  }

  get maxSize(): number {
    return this.lru.max;
  }

  get size(): number {
    return this.lru.size;
  }

  set(m: CachedMessage): void {
    this.lru.set(m.id, m);
  }

  get(id: string): CachedMessage | undefined {
    return this.lru.get(id);
  }

  updateContent(id: string, content: string): void {
    const m = this.lru.get(id);
    if (m) this.lru.set(id, { ...m, content });
  }

  /** Remove and return the entry. */
  take(id: string): CachedMessage | undefined {
    const m = this.lru.get(id);
    this.lru.delete(id);
    return m;
  }

  /** Change the capacity, keeping the most recently used entries. */
  resize(size: number): void {
    if (size === this.lru.max) return;
    const next = new LRUCache<string, CachedMessage>({ max: size });
    // rkeys() yields least-recently-used first, so the newest end up most recent in the new cache.
    for (const k of this.lru.rkeys()) {
      const v = this.lru.peek(k);
      if (v) next.set(k, v);
    }
    this.lru = next;
  }
}
