/** Response shapes shared by the API server and the dashboard. Plain types only. */

export interface ApiError {
  error: string;
  node?: string;
}

export interface UserRef {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/** Names for IDs mentioned in log summaries (<@id>, <@&id>, <#id>). */
export interface Mentions {
  users: Record<string, string>;
  roles: Record<string, { name: string; color: number }>;
  channels: Record<string, string>;
}

export interface MeResponse {
  user: { id: string; username: string; displayName: string; avatarUrl: string | null };
  csrfToken: string;
  /** Every concrete permission node this user is allowed. */
  allowedNodes: string[];
  guild: { name: string; iconUrl: string | null };
}

export interface CaseDto {
  caseNumber: number;
  action: string;
  label: string;
  targetId: string;
  targetType: 'user' | 'channel';
  targetName: string | null;
  moderatorId: string;
  moderatorName: string | null;
  reason: string | null;
  durationMs: number | null;
  expiresAt: string | null;
  source: string;
  active: boolean;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export interface OverviewResponse {
  guild: { name: string; iconUrl: string | null; memberCount: number; onlineCount: number | null };
  joinsLeaves: { date: string; joins: number; leaves: number }[];
  voice: {
    channelId: string;
    name: string;
    owner: UserRef | null;
    members: UserRef[];
  }[];
  topMembers: (UserRef & { score: number; messagePoints: number; voiceMinutes: number })[];
  activityWindowDays: number;
  recentCases: CaseDto[];
  canViewCases: boolean;
  health: {
    ready: boolean;
    wsPingMs: number | null;
    botUptimeSec: number;
    processUptimeSec: number;
    lastTierSync: { at: string; changed: number; members: number; errors: number } | null;
    jobs: { name: string; lastRunAt: string | null; lastError: string | null; nextRunAt: string | null }[];
  };
}

export interface MemberListItem {
  userId: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  isBot: boolean;
  joinedAt: string;
  tenureDays: number;
  score: number;
  messagePoints: number;
  voiceMinutes: number;
  tier: { name: string; roleId: string } | null;
  warnings: number | null;
}

export type MemberSort = 'name' | 'tenure' | 'activity' | 'warnings';

export interface MemberListResponse {
  total: number;
  page: number;
  pageSize: number;
  items: MemberListItem[];
}

export interface RoleDto {
  id: string;
  name: string;
  color: number;
  position: number;
  managed: boolean;
  /** The current user (and the bot) can add/remove it. */
  assignable: boolean;
}

export interface MemberDetailResponse {
  userId: string;
  inGuild: boolean;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  isBot: boolean;
  nickname: string | null;
  accountCreatedAt: string | null;
  joinedAt: string | null;
  firstJoinedAt: string | null;
  leftAt: string | null;
  tenureDays: number | null;
  timedOutUntil: string | null;
  roles: RoleDto[];
  activity: {
    windowDays: number;
    score: number;
    messagePoints: number;
    voiceMinutes: number;
    rank: number | null;
    history: { date: string; messagePoints: number; voiceMinutes: number }[];
  };
  tier: {
    current: { name: string; roleId: string } | null;
    next: { name: string; daysNeeded: number; pointsNeeded: number } | null;
  };
  /** Null when the viewer may not see moderation history (admin:case). */
  cases: CaseDto[] | null;
  /** Null when the viewer may not see warnings (admin:warnings). */
  activeWarnings: number | null;
  can: { warn: boolean; timeout: boolean; untimeout: boolean; kick: boolean; ban: boolean; role: boolean };
  mentions: Mentions;
}

export interface CaseListResponse {
  items: CaseDto[];
  nextBefore: number | null;
  mentions: Mentions;
}

export interface LogDto {
  id: number;
  type: string;
  event: string;
  actorId: string | null;
  targetId: string | null;
  channelId: string | null;
  summary: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export interface LogListResponse {
  items: LogDto[];
  nextBefore: number | null;
  mentions: Mentions;
}

export interface ActionResponse {
  ok: true;
  message: string;
  caseNumber?: number;
}

// ── Phase 6: management pages ────────────────────────────────────────────

export interface ChannelDto {
  id: string;
  name: string;
  kind: string;
  parentId: string | null;
}

/** A command option as the dashboard form needs it (mirrors src/shared/commandOptions.ts). */
export interface CommandOptionDto {
  name: string;
  kind: 'string' | 'integer' | 'number' | 'boolean' | 'user' | 'role' | 'channel' | 'duration';
  description: string;
  /** Required on the dashboard (context-default channels are required here). */
  required: boolean;
  choices?: { name: string; value: string | number }[];
  autocomplete?: boolean;
  multiline?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  channelTypes?: string[];
}

export interface CommandDto {
  fullName: string;
  description: string;
  node: string;
  category: string;
  options: CommandOptionDto[];
}

export interface RunCommandResponse {
  outcome: 'ok' | 'failed' | 'denied' | 'invalid' | 'error';
  result: {
    ok: boolean;
    content?: string;
    embeds?: {
      title?: string;
      description?: string;
      color?: number;
      fields?: { name: string; value: string; inline?: boolean }[];
      footer?: string;
      timestamp?: string;
      thumbnailUrl?: string;
    }[];
  };
  mentions: Mentions;
}

export type PermissionValue = boolean | null;

export interface PermissionsResponse {
  roles: { id: string; name: string; color: number; position: number; isEveryone: boolean }[];
  nodes: { node: string; description: string }[];
  rules: { roleId: string; node: string; allow: boolean }[];
  adminBypass: boolean;
}

export interface PermissionCheckResponse {
  node: string;
  allowed: boolean;
  reason: 'owner' | 'administrator' | 'rule' | 'default';
  explanation: string;
  rule: { roleId: string; node: string; allow: boolean } | null;
  member: UserRef;
}

export interface TierDto {
  id: number;
  name: string;
  roleId: string;
  roleName: string | null;
  roleColor: number;
  minTenureDays: number;
  minActivity: number;
  position: number;
  members: number;
  manageable: boolean;
  problem: string | null;
}

export interface SyncSummaryDto {
  at: string;
  reason: string;
  basis?: 'full' | 'tenure';
  members: number;
  changed: number;
  skipped: number;
  errors: number;
}

export interface TiersResponse {
  tiers: TierDto[];
  issues: string[];
  maxTiers: number;
  lastSync: SyncSummaryDto | null;
  lastTenureSync: SyncSummaryDto | null;
}

export interface HubDto {
  channelId: string;
  channelName: string | null;
  type: 'public' | 'private';
  categoryId: string;
  categoryName: string | null;
  nameTemplate: string;
  defaultLimit: number;
  hideFromEveryone: boolean;
}

export interface VoiceResponse {
  hubs: HubDto[];
  active: {
    channelId: string;
    name: string;
    hubChannelId: string;
    owner: UserRef | null;
    members: UserRef[];
  }[];
}

export type SettingsSection =
  | 'logs'
  | 'moderation'
  | 'permissions'
  | 'voice'
  | 'activity'
  | 'tenure'
  | 'tiers';

export interface SettingsResponse {
  /** The full settings object (see src/config/settings.ts). */
  settings: Record<SettingsSection, Record<string, unknown>>;
  editable: Record<SettingsSection, boolean>;
}

export interface AuditEntryDto {
  id: number;
  actor: UserRef;
  source: 'slash' | 'dashboard' | 'system';
  action: string;
  target: string | null;
  /** Human-readable target (role/tier/channel/member name) when it can be resolved. */
  targetLabel: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface AuditListResponse {
  items: AuditEntryDto[];
  nextBefore: number | null;
}
