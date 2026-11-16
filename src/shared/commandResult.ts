/**
 * Transport-neutral command output. Rendered as a Discord reply for slash commands and as JSON
 * for the dashboard, so neither side has to fake the other.
 */
export interface ResultEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface ResultEmbed {
  title?: string;
  description?: string;
  /** 0xRRGGBB */
  color?: number;
  fields?: ResultEmbedField[];
  footer?: string;
  timestamp?: string;
  thumbnailUrl?: string;
}

export interface CommandResult {
  ok: boolean;
  content?: string;
  embeds?: ResultEmbed[];
  /** Override the command's default ephemerality for this reply (Discord only). */
  ephemeral?: boolean;
}

export const COLORS = {
  info: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
  neutral: 0x99aab5,
} as const;

export const ok = (content: string, extra: Partial<CommandResult> = {}): CommandResult => ({
  ok: true,
  content,
  ...extra,
});
export const fail = (content: string): CommandResult => ({ ok: false, content, ephemeral: true });
