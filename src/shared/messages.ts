import type { ResultEmbed } from './commandResult.js';

/**
 * Transport-neutral message with optional components, used for messages the bot keeps and edits
 * (the status embed, role panels). The Discord adapter turns it into embeds and action rows.
 */
export interface MessageButton {
  customId: string;
  label: string;
  emoji?: string | null;
  style?: 'primary' | 'secondary' | 'success' | 'danger';
}

export interface MessageSelectOption {
  value: string;
  label: string;
  description?: string | null;
  emoji?: string | null;
}

export interface MessageSelect {
  customId: string;
  placeholder?: string;
  minValues: number;
  maxValues: number;
  options: MessageSelectOption[];
}

export interface OutgoingMessage {
  content?: string;
  embed?: ResultEmbed;
  /** Up to 25 buttons, laid out five per row. */
  buttons?: MessageButton[];
  select?: MessageSelect;
  /** Roles the content may ping. Nothing else is ever mentioned. */
  mentionRoleIds?: string[];
  /** Members the content may ping. */
  mentionUserIds?: string[];
}
