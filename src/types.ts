export type ItemStatus = "open" | "resolved" | "snoozed";
export type Urgency = "high" | "medium" | "low";
export type TraceState = "open" | "likely_handled" | "resolved_by_trace" | "unclear";
export type TraceStateConfidence = "low" | "medium" | "high";
export type ItemMessageRole = "user" | "llama" | "team" | "other";
export type ItemMessageKind = "issue" | "evidence";
export type ChatClassification =
  | "support_request"
  | "repo_followup"
  | "listing_help"
  | "data_update_question"
  | "logo_update_question"
  | "out_of_scope"
  | "needs_clarification";
export type ChatConfidence = "high" | "medium" | "low";
export type LearningFeedbackDomain = "chat_answer" | "scan_category" | "scan_resolution" | "scan_assignment";
export type LearningFeedbackKind = "confirmed" | "refined" | "corrected";
export type ReviewStatus = "pending" | "reviewed_good" | "reviewed_corrected" | "discarded" | "stale";
export type ReviewPromotionStatus = "not_promoted" | "promoted" | "retired";
export type BenchmarkOutcomeType = "answer" | "escalate" | "category" | "assignment_expectation" | "resolution_expectation";
export type BenchmarkStatus = "active" | "stale" | "retired";
export type BenchmarkSource = "promoted_trace" | "manual";

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
  referenceMessageId: string | null;
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
  github_assignee_hint: string | null;
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
  last_human_reply_text: string | null;
  trace_state: TraceState;
  trace_state_confidence: TraceStateConfidence;
  trace_answer_message_id: string | null;
  trace_answer_author_id: string | null;
  trace_answer_author_name: string | null;
  trace_answer_text: string | null;
  trace_answer_at: string | null;
  trace_answer_role: ItemMessageRole | null;
  linked_llama_reply_message_id: string | null;
  linked_llama_reply_author_id: string | null;
  linked_llama_reply_author_name: string | null;
  linked_llama_reply_text: string | null;
  linked_llama_reply_at: string | null;
  scan_id: number | null;
}

export interface ItemMessageRow {
  id: number;
  item_id: number;
  guild_id: string;
  channel_id: string;
  message_id: string;
  reference_message_id: string | null;
  message_url: string;
  author_id: string;
  author_name: string;
  content_preview: string | null;
  message_role: ItemMessageRole;
  evidence_kind: ItemMessageKind;
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

export interface ChatEngagementRow {
  id: number;
  guild_id: string;
  channel_id: string;
  user_id: string;
  user_message_id: string;
  bot_reply_message_id: string;
  anchor_message_id: string | null;
  conversation_key: string;
  classification: ChatClassification;
  confidence: ChatConfidence;
  needs_clarification: number;
  created_at: string;
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
  assigneeHint: string | null;
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

export interface KnowledgeDocumentRow {
  id: number;
  guild_id: string;
  channel_id: string;
  conversation_key: string;
  question_message_id: string;
  answer_message_id: string;
  question_author_id: string;
  question_author_name: string;
  answer_author_id: string;
  answer_author_name: string;
  question_text: string;
  context_text: string | null;
  answer_text: string;
  combined_text: string;
  content_fingerprint: string;
  source: "live" | "backfill";
  feedback_kind: "unreviewed" | "confirmed" | "refined" | "corrected";
  feedback_score: number;
  resolution_count: number;
  related_bot_reply_message_id: string | null;
  related_bot_classification: ChatClassification | null;
  related_bot_confidence: ChatConfidence | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeMatch {
  id: number;
  questionText: string;
  contextText: string | null;
  answerText: string;
  answerAuthorName: string;
  score: number;
  feedbackKind: "unreviewed" | "confirmed" | "refined" | "corrected";
  resolutionCount: number;
}

export interface LearningFeedbackRow {
  id: number;
  guild_id: string;
  domain: LearningFeedbackDomain;
  input_text: string;
  context_text: string | null;
  initial_output: string | null;
  corrected_output: string;
  feedback_kind: LearningFeedbackKind;
  weight: number;
  reinforcement_count: number;
  item_id: number | null;
  source_message_id: string | null;
  related_message_id: string | null;
  feedback_fingerprint: string;
  created_at: string;
  updated_at: string;
}

export interface LearningFeedbackMatch {
  id: number;
  domain: LearningFeedbackDomain;
  inputText: string;
  contextText: string | null;
  initialOutput: string | null;
  correctedOutput: string;
  feedbackKind: LearningFeedbackKind;
  weight: number;
  reinforcementCount: number;
  score: number;
}

export interface ReviewQueueRow {
  id: number;
  guild_id: string;
  source_domain: LearningFeedbackDomain;
  source_id: number | null;
  item_id: number | null;
  source_message_id: string | null;
  related_message_id: string | null;
  raw_input: string;
  raw_context: string | null;
  raw_initial_output: string | null;
  raw_corrected_output: string;
  feedback_kind: LearningFeedbackKind;
  weight: number;
  reinforcement_count: number;
  priority: number;
  review_status: ReviewStatus;
  promotion_status: ReviewPromotionStatus;
  notes: string | null;
  last_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewedPrecedentMatch {
  id: number;
  domain: LearningFeedbackDomain;
  inputText: string;
  contextText: string | null;
  initialOutput: string | null;
  correctedOutput: string;
  feedbackKind: LearningFeedbackKind;
  reviewStatus: ReviewStatus;
  promotionStatus: ReviewPromotionStatus;
  weight: number;
  reinforcementCount: number;
  score: number;
}

export interface TrustedValidatedAnswerMatch {
  id: number;
  domain: LearningFeedbackDomain;
  inputText: string;
  contextText: string | null;
  answerText: string;
  feedbackKind: LearningFeedbackKind;
  weight: number;
  reinforcementCount: number;
  confirmationCount: number;
  correctionCount: number;
  score: number;
}

export interface BenchmarkCaseRow {
  id: number;
  guild_id: string;
  source_review_id: number | null;
  source: BenchmarkSource;
  family: string;
  outcome_type: BenchmarkOutcomeType;
  canonical_input: string;
  canonical_context: string | null;
  target_output: string;
  status: BenchmarkStatus;
  notes: string | null;
  replaced_by_case_id: number | null;
  last_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BenchmarkRunRow {
  id: number;
  guild_id: string;
  triggered_by: string;
  notes: string | null;
  status: ScanStatus;
  active_case_count: number;
  passed_count: number;
  failed_count: number;
  started_at: string;
  completed_at: string | null;
}

export interface BenchmarkRunResultRow {
  id: number;
  run_id: number;
  case_id: number;
  family: string;
  passed: number;
  actual_output: string | null;
  score: number;
  notes: string | null;
  created_at: string;
}
