export type ItemStatus = "open" | "resolved" | "snoozed";
export type Urgency = "high" | "medium" | "low";

export type Category = string;

export type ScanStatus = "running" | "complete" | "failed";

export interface Config {
  discordToken: string;
  applicationId: string;
  guildId?: string;
  llmApiBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  githubToken?: string;
  databasePath: string;
  defaultLookbackHours: number;
  maxLookbackHours: number;
  batchSize: number;
  batchDelayMs: number;
  llmTimeoutMs: number;
  llmRetryCount: number;
  llmRetryBaseDelayMs: number;
  staleScanMinutes: number;
  debugLogs: boolean;
  botName: string;
}

export interface FetchedMessage {
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
  messageId: string;
  messageUrl: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface LlmIssueCandidate {
  message_id: string;
  related_message_ids: string[];
  user_id: string;
  username: string;
  summary: string;
  category: Category;
  urgency: Urgency;
}

export interface ScanBatch {
  channelId: string;
  channelName: string;
  messages: FetchedMessage[];
}

export interface ItemRow {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string;
  message_url: string;
  github_url: string | null;
  github_repo_label: string | null;
  github_ref_label: string | null;
  github_status: string | null;
  github_last_activity_at: string | null;
  github_synced_at: string | null;
  github_owner_hint: string | null;
  author_id: string;
  author_name: string;
  content_preview: string;
  summary: string;
  category: Category;
  urgency: Urgency;
  status: ItemStatus;
  assignee_id: string | null;
  assignee_name: string | null;
  source_message_created_at: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  snooze_until: string | null;
  snoozed_by: string | null;
  last_human_reply_at: string | null;
  last_human_reply_user_id: string | null;
  last_human_reply_name: string | null;
  scan_id: number | null;
}

export interface ItemMessageRow {
  id: number;
  item_id: number;
  guild_id: string;
  channel_id: string;
  message_id: string;
  message_url: string;
  author_id: string;
  author_name: string;
  source_message_created_at: string | null;
  created_at: string;
}

export interface ScanSummary {
  id: number;
  channelsScanned: number;
  channelsSkipped?: number;
  messagesFetched: number;
  messagesReused: number;
  messagesAnalyzed: number;
  batchesSkipped?: number;
  itemsFound: number;
  itemsNew: number;
  itemsReturning: number;
}

export interface ScannedMessageRow {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string;
  message_url: string;
  author_id: string;
  author_name: string;
  source_message_created_at: string | null;
  content_fingerprint: string;
  last_scan_id: number | null;
  last_analyzed_at: string | null;
  classification_state: "noise" | "item";
  item_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface ChannelScanCursorRow {
  guild_id: string;
  channel_id: string;
  latest_message_id: string;
  latest_message_created_at: string;
  updated_at: string;
}

export interface RenderedItem extends ItemRow {
  relatedCount: number;
  relatedChannels: string[];
  ageLabel: string;
  categoryColor: number;
  projectName: string | null;
}

export interface GithubEnrichment {
  url: string;
  repoLabel: string;
  refLabel: string;
  status: string | null;
  lastActivityAt: string | null;
  ownerHint: string | null;
}

export interface NormalizedIssueInput {
  guildId: string;
  channelId: string;
  messageId: string;
  messageUrl: string;
  authorId: string;
  authorName: string;
  content: string;
  summary: string;
  category: Category;
  urgency: Urgency;
  createdAt: string;
  allMessages: FetchedMessage[];
  scanId: number;
  assigneeId?: string | null;
  assigneeName?: string | null;
}

export interface CategoryRow {
  id: number;
  guild_id: string;
  name: string;
  color: number;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface CategoryAssigneeRow {
  id: number;
  guild_id: string;
  category_name: string;
  user_id: string;
  user_name: string;
  created_at: string;
}
