import { db } from "./client";

export function writeAuditLog(input: {
  guildId: string;
  actorId: string;
  actorName: string;
  action: string;
  target?: string;
  details?: unknown;
}): void {
  db.query(
    `INSERT INTO audit_log (guild_id, actor_id, actor_name, action, target, details)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    input.guildId,
    input.actorId,
    input.actorName,
    input.action,
    input.target ?? null,
    input.details ? JSON.stringify(input.details) : null
  );
}
