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
  topMembers: (UserRef & ActivityCounts & { score: number })[];
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

/** Activity counts over a period. `messagePoints` counts messages that earned a point. */
export interface ActivityCounts {
  messagePoints: number;
  voiceMinutes: number;
  /** Messages that earned the image bonus. */
  images: number;
  /** Messages that earned the link bonus. */
  links: number;
  /** Reactions given that earned points. */
  reactions: number;
  /** Reactions received from others that earned points. */
  reactionsReceived: number;
  /** Voice minutes past the long-session threshold (included in voiceMinutes). */
  voiceLongMinutes: number;
}

/** Short summary of the non-zero counts, e.g. "12 msg · 3 img · 40 voice min". */
export function activitySummary(c: ActivityCounts): string {
  const parts = [
    c.messagePoints ? `${c.messagePoints} msg` : null,
    c.images ? `${c.images} img` : null,
    c.links ? `${c.links} link${c.links === 1 ? '' : 's'}` : null,
    c.reactions ? `${c.reactions} react` : null,
    c.reactionsReceived ? `${c.reactionsReceived} reacts received` : null,
    c.voiceMinutes ? `${c.voiceMinutes} voice min` : null,
  ].filter(Boolean);
  return parts.join(' · ') || 'No activity';
}

/** Weighted points from each kind of activity (current weights). */
export interface ActivityPoints {
  messages: number;
  voice: number;
  images: number;
  links: number;
  reactions: number;
  reactionsReceived: number;
}

export interface MemberListItem extends ActivityCounts {
  userId: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  isBot: boolean;
  joinedAt: string;
  tenureDays: number;
  score: number;
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
  activity: ActivityCounts & {
    windowDays: number;
    score: number;
    rank: number | null;
    history: (ActivityCounts & { date: string; points: ActivityPoints })[];
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

// ── Status (Uptime Kuma) ──

export type MonitorStatusDto = 'up' | 'down' | 'pending' | 'maintenance' | 'unknown';

export interface StatusMonitorDto {
  id: number;
  name: string;
  group: string;
  status: MonitorStatusDto;
  ping: number | null;
  message: string;
  checkedAt: string | null;
  uptime24h: number | null;
  /** Role pinged by this monitor's alerts. */
  alertRoleId: string | null;
}

export interface StatusResponse {
  config: {
    kumaUrl: string | null;
    slug: string | null;
    channelId: string | null;
    intervalSeconds: number;
    alertChannelId: string | null;
  };
  configured: boolean;
  title: string | null;
  monitors: StatusMonitorDto[];
  fetchedAt: string | null;
  error: string | null;
  errorSince: string | null;
  /** Where the pinned embed is. null when not posted. */
  message: { channelId: string; messageId: string } | null;
}

export interface StatusTestResponse {
  title: string;
  monitors: number;
}

// ── Role panels ──

export interface RolePanelOptionDto {
  roleId: string;
  label: string;
  emoji: string | null;
  description: string | null;
}

export interface RolePanelDto {
  id: number;
  title: string;
  description: string;
  style: 'buttons' | 'select';
  mode: 'multi' | 'single';
  options: RolePanelOptionDto[];
  channelId: string | null;
  channelName: string | null;
}

export interface PanelRoleDto {
  id: string;
  name: string;
  color: number;
  /** Why the role can't be offered on a panel; null when it can. */
  problem: string | null;
}

export interface RolePanelsResponse {
  panels: RolePanelDto[];
  roles: PanelRoleDto[];
}

// ── Belltower issue reports ──

export type BelltowerPriority = 'P0' | 'P1' | 'P2' | 'P3';

export interface IssueReportDto {
  id: number;
  reporterId: string;
  /** Display name when the member is cached, else null. */
  reporterName: string | null;
  channelId: string | null;
  service: string;
  monitorId: number | null;
  details: string | null;
  cardId: number;
  ticketNo: string | null;
  /** created: opened the ticket. updated: added to an open one. */
  cardStatus: 'created' | 'updated';
  /** received, in_progress, waiting, done, archived, deleted, missing, duplicate or dismissed. */
  state: string;
  resolution: string | null;
  createdAt: string;
  closedAt: string | null;
  notifiedVia: 'dm' | 'channel' | 'none' | null;
}

/** A ticket sent through Belltower's submit page (link mode). */
export interface SubmittedTicketDto {
  cardId: number;
  ticketNo: string | null;
  title: string;
  /** The name typed on the submit page. */
  submitter: string | null;
  /** received, in_progress, waiting, done, archived, deleted or missing. */
  state: string;
  resolution: string | null;
  createdAt: string;
  closedAt: string | null;
}

export interface BelltowerResponse {
  /** BELLTOWER_URL and BELLTOWER_TOKEN are set. */
  configured: boolean;
  /** The panel can be posted: the API is set up, or (link mode) the submit page link is. */
  panelReady: boolean;
  error: string | null;
  errorSince: string | null;
  lastPollAt: string | null;
  config: {
    enabled: boolean;
    labels: string[];
    priority: BelltowerPriority | null;
    column: string | null;
    cooldownSeconds: number;
    panelChannelId: string | null;
    /** api: Bernard files tickets. link: the panel opens Belltower's submit page. */
    mode: 'api' | 'link';
    submitUrl: string | null;
  };
  panel: { channelId: string; messageId: string } | null;
  open: IssueReportDto[];
  recent: IssueReportDto[];
  /** Submit-page tickets, read while in link mode. */
  submitted: { open: SubmittedTicketDto[]; recent: SubmittedTicketDto[] };
}
