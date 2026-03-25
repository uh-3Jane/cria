import type { ChatInputCommandInteraction, GuildMember, User } from "discord.js";
import { db } from "./db/client";

function isGuildOwner(interaction: ChatInputCommandInteraction): boolean {
  return interaction.guild?.ownerId === interaction.user.id;
}

export function isAdminUser(guildId: string, userId: string): boolean {
  const row = db.query(`SELECT 1 FROM admins WHERE guild_id = ? AND user_id = ? LIMIT 1`).get(guildId, userId) as
    | { 1: number }
    | null;
  return Boolean(row);
}

export function assertAdmin(interaction: ChatInputCommandInteraction): void {
  if (!interaction.guildId) {
    throw new Error("guild only command");
  }
  if (isGuildOwner(interaction) || isAdminUser(interaction.guildId, interaction.user.id)) {
    return;
  }
  throw new Error("admin only");
}

export function assertOwner(interaction: ChatInputCommandInteraction): void {
  if (!isGuildOwner(interaction)) {
    throw new Error("server owner only");
  }
}

export function memberDisplayName(member: GuildMember | null, user: User): string {
  return member?.displayName ?? user.username;
}
