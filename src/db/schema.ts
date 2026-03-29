import { db } from "./client";

function hasColumn(table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((row) => row.name === column);
}

function snowflakeToIso(id: string): string | null {
  try {
    const discordEpoch = 1420070400000n;
    const timestamp = Number((BigInt(id) >> 22n) + discordEpoch);
    return new Date(timestamp).toISOString();
  } catch {
    return null;
  }
}

export function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      message_url TEXT NOT NULL,
      github_url TEXT,
      github_repo_label TEXT,
      github_ref_label TEXT,
      github_status TEXT,
      github_last_activity_at DATETIME,
      github_synced_at DATETIME,
      github_owner_hint TEXT,
      github_assignee_hint TEXT,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      content_preview TEXT NOT NULL,
      summary TEXT NOT NULL,
      category TEXT NOT NULL,
      urgency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      assignee_id TEXT,
      assignee_name TEXT,
      source_message_created_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      resolved_by TEXT,
      snooze_until DATETIME,
      snoozed_by TEXT,
      last_human_reply_at DATETIME,
      last_human_reply_user_id TEXT,
      last_human_reply_name TEXT,
      scan_id INTEGER REFERENCES scans(id)
    );

    CREATE TABLE IF NOT EXISTS item_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id),
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      message_url TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      content_preview TEXT,
      source_message_created_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      triggered_by TEXT NOT NULL,
      lookback_hours INTEGER NOT NULL,
      channels_scanned INTEGER NOT NULL,
      messages_fetched INTEGER NOT NULL DEFAULT 0,
      messages_reused INTEGER NOT NULL DEFAULT 0,
      messages_analyzed INTEGER NOT NULL,
      items_found INTEGER NOT NULL,
      items_new INTEGER NOT NULL,
      items_returning INTEGER NOT NULL,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      status TEXT NOT NULL DEFAULT 'running'
    );

    CREATE TABLE IF NOT EXISTS ignore_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      category TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      created_by TEXT NOT NULL,
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, author_id, category, fingerprint)
    );

    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_by TEXT NOT NULL,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS guild_config (
      guild_id TEXT PRIMARY KEY,
      default_lookback_hours INTEGER NOT NULL DEFAULT 24,
      scan_emissions_channel_id TEXT,
      chat_enabled INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS chat_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS chat_engagements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL UNIQUE,
      bot_reply_message_id TEXT NOT NULL UNIQUE,
      anchor_message_id TEXT,
      conversation_key TEXT NOT NULL,
      classification TEXT NOT NULL DEFAULT 'needs_clarification',
      confidence TEXT NOT NULL DEFAULT 'low',
      needs_clarification INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, name)
    );

    CREATE TABLE IF NOT EXISTS category_assignees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      category_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, category_name, user_id)
    );

    CREATE TABLE IF NOT EXISTS scanned_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      message_url TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      source_message_created_at DATETIME,
      content_fingerprint TEXT NOT NULL,
      last_scan_id INTEGER REFERENCES scans(id),
      last_analyzed_at DATETIME,
      classification_state TEXT NOT NULL DEFAULT 'noise',
      item_id INTEGER REFERENCES items(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS channel_scan_cursors (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      latest_message_id TEXT NOT NULL,
      latest_message_created_at DATETIME NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      question_message_id TEXT NOT NULL,
      answer_message_id TEXT NOT NULL,
      question_author_id TEXT NOT NULL,
      question_author_name TEXT NOT NULL,
      answer_author_id TEXT NOT NULL,
      answer_author_name TEXT NOT NULL,
      question_text TEXT NOT NULL,
      context_text TEXT,
      answer_text TEXT NOT NULL,
      combined_text TEXT NOT NULL,
      content_fingerprint TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'live',
      feedback_kind TEXT NOT NULL DEFAULT 'unreviewed',
      feedback_score INTEGER NOT NULL DEFAULT 0,
      resolution_count INTEGER NOT NULL DEFAULT 0,
      related_bot_reply_message_id TEXT,
      related_bot_classification TEXT,
      related_bot_confidence TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, answer_message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_items_guild_status ON items(guild_id, status);
    CREATE INDEX IF NOT EXISTS idx_items_message_id ON items(message_id);
    CREATE INDEX IF NOT EXISTS idx_items_author_category ON items(author_id, category);
    CREATE INDEX IF NOT EXISTS idx_ignore_rules_lookup ON ignore_rules(guild_id, author_id);
    CREATE INDEX IF NOT EXISTS idx_item_messages_item_id ON item_messages(item_id);
    CREATE INDEX IF NOT EXISTS idx_categories_guild_active ON categories(guild_id, active);
    CREATE INDEX IF NOT EXISTS idx_category_assignees_guild_category ON category_assignees(guild_id, category_name);
    CREATE INDEX IF NOT EXISTS idx_scanned_messages_guild_channel ON scanned_messages(guild_id, channel_id);
    CREATE INDEX IF NOT EXISTS idx_scanned_messages_item_id ON scanned_messages(item_id);
    CREATE INDEX IF NOT EXISTS idx_channel_scan_cursors_guild_channel ON channel_scan_cursors(guild_id, channel_id);
    CREATE INDEX IF NOT EXISTS idx_chat_channels_guild ON chat_channels(guild_id);
    CREATE INDEX IF NOT EXISTS idx_chat_engagements_guild_user_message ON chat_engagements(guild_id, user_message_id);
    CREATE INDEX IF NOT EXISTS idx_chat_engagements_guild_anchor_message ON chat_engagements(guild_id, anchor_message_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_documents_guild_updated ON knowledge_documents(guild_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_documents_guild_question ON knowledge_documents(guild_id, question_message_id);
  `);

  if (!hasColumn("guild_config", "scan_emissions_channel_id")) {
    db.exec(`ALTER TABLE guild_config ADD COLUMN scan_emissions_channel_id TEXT;`);
  }
  if (!hasColumn("guild_config", "chat_enabled")) {
    db.exec(`ALTER TABLE guild_config ADD COLUMN chat_enabled INTEGER NOT NULL DEFAULT 0;`);
  }
  if (!hasColumn("scans", "messages_fetched")) {
    db.exec(`ALTER TABLE scans ADD COLUMN messages_fetched INTEGER NOT NULL DEFAULT 0;`);
  }
  if (!hasColumn("scans", "messages_reused")) {
    db.exec(`ALTER TABLE scans ADD COLUMN messages_reused INTEGER NOT NULL DEFAULT 0;`);
  }
  if (!hasColumn("items", "source_message_created_at")) {
    db.exec(`ALTER TABLE items ADD COLUMN source_message_created_at DATETIME;`);
  }
  if (!hasColumn("items", "github_url")) {
    db.exec(`ALTER TABLE items ADD COLUMN github_url TEXT;`);
  }
  if (!hasColumn("items", "github_repo_label")) {
    db.exec(`ALTER TABLE items ADD COLUMN github_repo_label TEXT;`);
  }
  if (!hasColumn("items", "github_ref_label")) {
    db.exec(`ALTER TABLE items ADD COLUMN github_ref_label TEXT;`);
  }
  if (!hasColumn("items", "github_status")) {
    db.exec(`ALTER TABLE items ADD COLUMN github_status TEXT;`);
  }
  if (!hasColumn("items", "github_last_activity_at")) {
    db.exec(`ALTER TABLE items ADD COLUMN github_last_activity_at DATETIME;`);
  }
  if (!hasColumn("items", "github_synced_at")) {
    db.exec(`ALTER TABLE items ADD COLUMN github_synced_at DATETIME;`);
  }
  if (!hasColumn("items", "github_owner_hint")) {
    db.exec(`ALTER TABLE items ADD COLUMN github_owner_hint TEXT;`);
  }
  if (!hasColumn("items", "github_assignee_hint")) {
    db.exec(`ALTER TABLE items ADD COLUMN github_assignee_hint TEXT;`);
  }
  if (!hasColumn("items", "last_human_reply_user_id")) {
    db.exec(`ALTER TABLE items ADD COLUMN last_human_reply_user_id TEXT;`);
  }
  if (!hasColumn("items", "last_human_reply_name")) {
    db.exec(`ALTER TABLE items ADD COLUMN last_human_reply_name TEXT;`);
  }
  if (!hasColumn("chat_engagements", "conversation_key")) {
    db.exec(`ALTER TABLE chat_engagements ADD COLUMN conversation_key TEXT;`);
    db.exec(`UPDATE chat_engagements SET conversation_key = COALESCE(anchor_message_id, user_message_id) WHERE conversation_key IS NULL;`);
  }
  if (!hasColumn("chat_engagements", "classification")) {
    db.exec(`ALTER TABLE chat_engagements ADD COLUMN classification TEXT NOT NULL DEFAULT 'needs_clarification';`);
  }
  if (!hasColumn("chat_engagements", "confidence")) {
    db.exec(`ALTER TABLE chat_engagements ADD COLUMN confidence TEXT NOT NULL DEFAULT 'low';`);
  }
  if (!hasColumn("chat_engagements", "needs_clarification")) {
    db.exec(`ALTER TABLE chat_engagements ADD COLUMN needs_clarification INTEGER NOT NULL DEFAULT 0;`);
  }
  if (!hasColumn("knowledge_documents", "feedback_kind")) {
    db.exec(`ALTER TABLE knowledge_documents ADD COLUMN feedback_kind TEXT NOT NULL DEFAULT 'unreviewed';`);
  }
  if (!hasColumn("knowledge_documents", "feedback_score")) {
    db.exec(`ALTER TABLE knowledge_documents ADD COLUMN feedback_score INTEGER NOT NULL DEFAULT 0;`);
  }
  if (!hasColumn("knowledge_documents", "resolution_count")) {
    db.exec(`ALTER TABLE knowledge_documents ADD COLUMN resolution_count INTEGER NOT NULL DEFAULT 0;`);
  }
  if (!hasColumn("knowledge_documents", "related_bot_reply_message_id")) {
    db.exec(`ALTER TABLE knowledge_documents ADD COLUMN related_bot_reply_message_id TEXT;`);
  }
  if (!hasColumn("knowledge_documents", "related_bot_classification")) {
    db.exec(`ALTER TABLE knowledge_documents ADD COLUMN related_bot_classification TEXT;`);
  }
  if (!hasColumn("knowledge_documents", "related_bot_confidence")) {
    db.exec(`ALTER TABLE knowledge_documents ADD COLUMN related_bot_confidence TEXT;`);
  }
  if (!hasColumn("item_messages", "source_message_created_at")) {
    db.exec(`ALTER TABLE item_messages ADD COLUMN source_message_created_at DATETIME;`);
  }

  if (!hasColumn("item_messages", "content_preview")) {
    db.exec(`ALTER TABLE item_messages ADD COLUMN content_preview TEXT;`);
  }

  const itemMessageRows = db
    .query(`SELECT id, message_id FROM item_messages WHERE source_message_created_at IS NULL`)
    .all() as { id: number; message_id: string }[];
  const updateItemMessage = db.query(`UPDATE item_messages SET source_message_created_at = ? WHERE id = ?`);
  for (const row of itemMessageRows) {
    const iso = snowflakeToIso(row.message_id);
    if (iso) {
      updateItemMessage.run(iso, row.id);
    }
  }

  const itemRows = db
    .query(`SELECT id, message_id FROM items WHERE source_message_created_at IS NULL`)
    .all() as { id: number; message_id: string }[];
  const updateItem = db.query(`UPDATE items SET source_message_created_at = ? WHERE id = ?`);
  for (const row of itemRows) {
    const iso = snowflakeToIso(row.message_id);
    if (iso) {
      updateItem.run(iso, row.id);
    }
  }
}
