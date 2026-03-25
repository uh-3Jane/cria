import { EmbedBuilder, type ChatInputCommandInteraction, type Message } from "discord.js";
import { assertAdmin } from "../access";
import { config } from "../config";
import {
  addAdmin,
  addChatChannel,
  addCategory,
  addCategoryAssignee,
  clearScanEmissionsChannel,
  getConfigStatus,
  getAuditEntries,
  getItems,
  listChatChannels,
  listCategories,
  listCategoryAssignees,
  listAdmins,
  recategorizeItem,
  removeChatChannel,
  removeCategory,
  removeCategoryAssignee,
  renameCategory,
  reopenItem,
  removeAdmin,
  setChatEnabled,
  setScanEmissionsChannel,
  unsnoozeItem,
  upsertGuildConfig
} from "../issues/store";
import { bindSummaryMessage, createDigestSession, renderIssuePage, replaceSessionCards, summaryMessagePayload } from "../issues/digest";
import { hoursFromPeriod } from "../utils/time";

export async function handleIssuesCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  assertAdmin(interaction);
  if (!interaction.guildId) {
    throw new Error("guild only command");
  }
  const items = getItems({ guildId: interaction.guildId, status: "open" });
  const session = createDigestSession({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    items,
    meta: {
      mode: "issues",
      totalCount: items.length
    }
  });
  await interaction.reply({ ...summaryMessagePayload(session), ephemeral: false });
  const summaryMessage = (await interaction.fetchReply()) as Message;
  bindSummaryMessage(session.id, summaryMessage.id);
  if (interaction.channel && "send" in interaction.channel && "messages" in interaction.channel) {
    await replaceSessionCards({
      session,
      items,
      channel: interaction.channel,
      guild: interaction.guild
    });
  }
}

export async function handleSimpleList(interaction: ChatInputCommandInteraction, status: "resolved" | "snoozed"): Promise<void> {
  assertAdmin(interaction);
  if (!interaction.guildId) {
    throw new Error("guild only command");
  }
  const items = getItems({ guildId: interaction.guildId, status });
  const session = createDigestSession({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    items,
    meta: {
      mode: status,
      totalCount: items.length
    }
  });
  await interaction.reply({ ...summaryMessagePayload(session), ephemeral: false });
  const summaryMessage = (await interaction.fetchReply()) as Message;
  bindSummaryMessage(session.id, summaryMessage.id);
  if (interaction.channel && "send" in interaction.channel && "messages" in interaction.channel) {
    await replaceSessionCards({
      session,
      items,
      channel: interaction.channel,
      guild: interaction.guild
    });
  }
}

export async function handleReopen(interaction: ChatInputCommandInteraction): Promise<void> {
  assertAdmin(interaction);
  if (!interaction.guildId) {
    throw new Error("guild only command");
  }
  const id = interaction.options.getInteger("id", true);
  reopenItem(id, interaction.guildId, interaction.user.id, interaction.user.username);
  await interaction.reply({ content: `reopened #${id}.`, ephemeral: true });
}

export async function handleIssue(interaction: ChatInputCommandInteraction): Promise<void> {
  assertAdmin(interaction);
  if (!interaction.guildId) {
    throw new Error("guild only command");
  }
  const subcommand = interaction.options.getSubcommand(true);
  if (subcommand !== "category") {
    throw new Error("unknown issue command");
  }
  const id = interaction.options.getInteger("id", true);
  const category = interaction.options.getString("category", true);
  const normalized = recategorizeItem(id, interaction.guildId, category, interaction.user.id, interaction.user.username);
  await interaction.reply({ content: `#${id} moved to ${normalized}.`, ephemeral: true });
}

export async function handleUnsnooze(interaction: ChatInputCommandInteraction): Promise<void> {
  assertAdmin(interaction);
  if (!interaction.guildId) {
    throw new Error("guild only command");
  }
  const id = interaction.options.getInteger("id", true);
  unsnoozeItem(id, interaction.guildId, interaction.user.id, interaction.user.username);
  await interaction.reply({ content: `unsnoozed #${id}.`, ephemeral: true });
}

export async function handleConfig(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    throw new Error("guild only command");
  }
  const subcommand = interaction.options.getSubcommand(true);
  if (subcommand === "status") {
    assertAdmin(interaction);
    const status = getConfigStatus(interaction.guildId, config.defaultLookbackHours);
    const embed = new EmbedBuilder().setTitle("config status").setDescription(
      `lookback: ${status.lookbackHours}h\nscan channel: ${status.scanEmissionsChannelId ? `<#${status.scanEmissionsChannelId}>` : "none"}\nchatbot: ${status.chatEnabled ? "on" : "off"}\nchat channels: ${status.chatChannelIds.length > 0 ? status.chatChannelIds.map((id) => `<#${id}>`).join(", ") : "none"}\nopen: ${status.openCount}\nsnoozed: ${status.snoozedCount}\nresolved: ${status.resolvedCount}\nlast scan: ${status.lastScanAt ?? "never"}`
    );
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (subcommand === "lookback") {
    if (interaction.guild?.ownerId !== interaction.user.id) {
      throw new Error("server owner only");
    }
    const duration = interaction.options.getString("duration", true);
    const hours = Math.min(hoursFromPeriod(duration), config.maxLookbackHours);
    upsertGuildConfig(interaction.guildId, hours);
    await interaction.reply({ content: `default lookback set to ${hours}h.`, ephemeral: true });
    return;
  }

  if (subcommand === "emissions-show") {
    assertAdmin(interaction);
    const status = getConfigStatus(interaction.guildId, config.defaultLookbackHours);
    await interaction.reply({
      content: status.scanEmissionsChannelId ? `scan results post in <#${status.scanEmissionsChannelId}>.` : "no scan emissions channel set.",
      ephemeral: true
    });
    return;
  }

  if (subcommand === "chat-list") {
    assertAdmin(interaction);
    const channels = listChatChannels(interaction.guildId);
    await interaction.reply({
      content: channels.length > 0 ? channels.map((id) => `<#${id}>`).join("\n") : "no chatbot channels configured.",
      ephemeral: true
    });
    return;
  }

  if (interaction.guild?.ownerId !== interaction.user.id) {
    throw new Error("server owner only");
  }

  if (subcommand === "emissions-set") {
    const channel = interaction.options.getChannel("channel", true);
    setScanEmissionsChannel(interaction.guildId, channel.id);
    await interaction.reply({ content: `scan results will post in <#${channel.id}>.`, ephemeral: true });
    return;
  }

  if (subcommand === "emissions-clear") {
    clearScanEmissionsChannel(interaction.guildId);
    await interaction.reply({ content: "scan emissions channel cleared.", ephemeral: true });
    return;
  }

  if (subcommand === "chat-on") {
    setChatEnabled(interaction.guildId, true);
    await interaction.reply({ content: "chatbot enabled.", ephemeral: true });
    return;
  }

  if (subcommand === "chat-off") {
    setChatEnabled(interaction.guildId, false);
    await interaction.reply({ content: "chatbot disabled.", ephemeral: true });
    return;
  }

  if (subcommand === "chat-add-channel") {
    const channel = interaction.options.getChannel("channel", true);
    addChatChannel(interaction.guildId, channel.id);
    await interaction.reply({ content: `chatbot allowed in <#${channel.id}>.`, ephemeral: true });
    return;
  }

  if (subcommand === "chat-remove-channel") {
    const channel = interaction.options.getChannel("channel", true);
    removeChatChannel(interaction.guildId, channel.id);
    await interaction.reply({ content: `chatbot removed from <#${channel.id}>.`, ephemeral: true });
  }
}

export async function handleCategory(interaction: ChatInputCommandInteraction): Promise<void> {
  assertAdmin(interaction);
  if (!interaction.guildId) {
    throw new Error("guild only command");
  }
  const guildId = interaction.guildId;
  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(true);

  if (subcommand === "list" && !subcommandGroup) {
    const categories = listCategories(guildId);
    const lines = categories.map((category) => {
      const name = category.name ?? "general";
      const assignees = listCategoryAssignees(guildId, name);
      return `- ${name}${assignees.length > 0 ? `: ${assignees.map((row) => `<@${row.user_id}>`).join(", ")}` : ""}`;
    });
    await interaction.reply({ content: lines.join("\n") || "no categories.", ephemeral: true });
    return;
  }

  if (subcommand === "add" && !subcommandGroup) {
    const created = addCategory(guildId, interaction.options.getString("name", true), interaction.user.id, interaction.user.username);
    await interaction.reply({ content: `added ${created}.`, ephemeral: true });
    return;
  }

  if (subcommand === "rename" && !subcommandGroup) {
    const result = renameCategory(
      guildId,
      interaction.options.getString("old", true),
      interaction.options.getString("new", true),
      interaction.user.id,
      interaction.user.username
    );
    await interaction.reply({ content: `renamed ${result.from} to ${result.to}.`, ephemeral: true });
    return;
  }

  if (subcommand === "remove" && !subcommandGroup) {
    const removed = removeCategory(guildId, interaction.options.getString("name", true), interaction.user.id, interaction.user.username);
    await interaction.reply({ content: `removed ${removed}; existing issues moved to general.`, ephemeral: true });
    return;
  }

  if (subcommandGroup === "assignees" && subcommand === "list") {
    const category = interaction.options.getString("category", true);
    const assignees = listCategoryAssignees(guildId, category);
    await interaction.reply({
      content: assignees.length > 0 ? assignees.map((row) => `<@${row.user_id}>`).join("\n") : "no default assignees.",
      ephemeral: true
    });
    return;
  }

  if (subcommandGroup === "assignees" && subcommand === "add") {
    const category = interaction.options.getString("category", true);
    const user = interaction.options.getUser("user", true);
    const normalized = addCategoryAssignee(guildId, category, user.id, user.username, interaction.user.id, interaction.user.username);
    await interaction.reply({ content: `added <@${user.id}> to ${normalized}.`, ephemeral: true });
    return;
  }

  if (subcommandGroup === "assignees" && subcommand === "remove") {
    const category = interaction.options.getString("category", true);
    const user = interaction.options.getUser("user", true);
    const normalized = removeCategoryAssignee(guildId, category, user.id, interaction.user.id, interaction.user.username);
    await interaction.reply({ content: `removed <@${user.id}> from ${normalized}.`, ephemeral: true });
    return;
  }
}

export async function handleAdmin(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    throw new Error("guild only command");
  }
  const subcommand = interaction.options.getSubcommand(true);
  if (subcommand === "list") {
    assertAdmin(interaction);
    const admins = listAdmins(interaction.guildId);
    await interaction.reply({ content: admins.length > 0 ? admins.map((id) => `<@${id}>`).join("\n") : "no admins yet.", ephemeral: true });
    return;
  }
  if (subcommand === "audit") {
    assertAdmin(interaction);
    const entries = getAuditEntries(interaction.guildId, 20);
    await interaction.reply({
      content: entries.length > 0
        ? entries.map((entry) => `${entry.created_at} - ${entry.actor_name} - ${entry.action}${entry.target ? ` ${entry.target}` : ""}`).join("\n")
        : "no audit entries.",
      ephemeral: true
    });
    return;
  }
  if (interaction.guild?.ownerId !== interaction.user.id) {
    throw new Error("server owner only");
  }
  const user = interaction.options.getUser("user", true);
  if (subcommand === "add") {
    addAdmin(interaction.guildId, user.id, interaction.user.id, interaction.user.username);
    await interaction.reply({
      content: `added <@${user.id}> as admin.\ntry \`/cria list\` to see what i can do.`,
      ephemeral: true
    });
    return;
  }
  if (subcommand === "remove") {
    removeAdmin(interaction.guildId, user.id, interaction.user.id, interaction.user.username);
    await interaction.reply({ content: `removed <@${user.id}> as admin.`, ephemeral: true });
  }
}

export async function handleCria(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand(true);
  if (subcommand !== "list") {
    throw new Error("unknown cria command");
  }

  await interaction.reply({
    content: [
      "commands:",
      "/scan",
      "/issues",
      "/issue category",
      "/resolved",
      "/reopen",
      "/unsnooze",
      "/snoozed",
      "/category list",
      "/category add",
      "/category rename",
      "/category remove",
      "/category assignees add",
      "/category assignees remove",
      "/category assignees list",
      "/config status",
      "/config lookback",
      "/config emissions-set",
      "/config emissions-show",
      "/config emissions-clear",
      "/config chat-on",
      "/config chat-off",
      "/config chat-add-channel",
      "/config chat-remove-channel",
      "/config chat-list",
      "/admin add",
      "/admin remove",
      "/admin list",
      "/admin audit",
      "/cria list"
    ].join("\n"),
    ephemeral: true
  });
}
