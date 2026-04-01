import {
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type Interaction
} from "discord.js";
import { assertAdmin } from "../access";
import { handleAdmin, handleCategory, handleConfig, handleCria, handleIssue, handleIssuesCommand, handleReopen, handleSimpleList, handleUnsnooze } from "../commands/issues";
import { runScan } from "../commands/scan";
import { assignItem, getActiveCategoryNames, getItem, getItems, recategorizeItem, resolveItem, reopenItem, snoozeItem, unsnoozeItem } from "../issues/store";
import { getDigestSession, itemCardPayload, renderIssuePage, replaceSessionCards, setDigestPage, summaryMessagePayload } from "../issues/digest";
import { logDebug, logError } from "../utils/logger";

const LLAMA_ROLE_NAME = "llama";

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  switch (interaction.commandName) {
    case "scan":
      return runScan(interaction);
    case "issues":
      return handleIssuesCommand(interaction);
    case "issue":
      return handleIssue(interaction);
    case "reopen":
      return handleReopen(interaction);
    case "unsnooze":
      return handleUnsnooze(interaction);
    case "snoozed":
      return handleSimpleList(interaction, "snoozed");
    case "resolved":
      return handleSimpleList(interaction, "resolved");
    case "config":
      return handleConfig(interaction);
    case "category":
      return handleCategory(interaction);
    case "admin":
      return handleAdmin(interaction);
    case "cria":
      return handleCria(interaction);
    default:
      await interaction.reply({ content: "unknown command.", ephemeral: true });
  }
}

function parseCustomId(customId: string): string[] {
  return customId.split(":");
}

async function listLlamaOptions(guild: Guild): Promise<Array<{ label: string; value: string; description?: string }>> {
  const llamaRole = guild.roles.cache.find((role) => role.name.toLowerCase() === LLAMA_ROLE_NAME)
    ?? (await guild.roles.fetch().then(() => guild.roles.cache.find((role) => role.name.toLowerCase() === LLAMA_ROLE_NAME)));
  if (!llamaRole) {
    return [];
  }
  const members = await guild.members.fetch();
  return members
    .filter((member) => !member.user.bot)
    .filter((member) => member.roles.cache.has(llamaRole.id))
    .map((member) => ({
      label: member.displayName.slice(0, 100),
      value: member.id,
      description: member.user.username && member.user.username !== member.displayName
        ? member.user.username.slice(0, 100)
        : undefined
    }))
    .sort((left, right) => left.label.localeCompare(right.label))
    .slice(0, 25);
}

async function refreshIssueList(interaction: ButtonInteraction, page: number): Promise<void> {
  if (!interaction.guildId) {
    return;
  }
  logDebug("interaction.button.nav_compact.update", {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    interactionMessageId: interaction.message.id,
    page
  });
  const items = getItems({ guildId: interaction.guildId, status: "open" });
  const rendered = renderIssuePage(items, page, "issues");
  await interaction.update(rendered);
}

async function refreshItemCard(interaction: ButtonInteraction, itemId: number): Promise<void> {
  if (!interaction.guildId) {
    return;
  }
  logDebug("interaction.card.refresh.start", {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    interactionMessageId: interaction.message.id,
    itemId
  });
  const item = getItem(itemId, interaction.guildId);
  if (!item) {
    await interaction.update({ content: "item not found.", components: [], embeds: [] });
    return;
  }
  const items = getItems({ guildId: interaction.guildId, status: undefined }).filter((candidate) => candidate.id === itemId);
  const rendered = items[0];
  if (!rendered) {
    await interaction.update({ content: "item not found.", components: [], embeds: [] });
    return;
  }
  await interaction.update(itemCardPayload(rendered, interaction.guild));
  logDebug("interaction.card.refresh.success", {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    interactionMessageId: interaction.message.id,
    itemId
  });
}

async function refreshCardMessageById(
  interaction: Interaction,
  guildId: string,
  itemId: number,
  rawCardMessageId: string
): Promise<void> {
  logDebug("interaction.card.refresh_by_id.start", {
    guildId,
    itemId,
    rawCardMessageId,
    channelId: "channelId" in interaction ? interaction.channelId : null
  });
  const cardMessage = interaction.channel && "messages" in interaction.channel
    ? await interaction.channel.messages.fetch(rawCardMessageId).catch(() => null)
    : null;
  const rendered = getItems({ guildId }).find((item) => item.id === itemId);
  if (cardMessage && rendered) {
    await cardMessage.edit(itemCardPayload(rendered, interaction.guild ?? null));
    logDebug("interaction.card.refresh_by_id.success", {
      guildId,
      itemId,
      rawCardMessageId
    });
  }
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  assertAdmin(interaction as unknown as ChatInputCommandInteraction);
  const [action, rawA, rawB] = parseCustomId(interaction.customId);
  if (!interaction.guildId) {
    return;
  }

  if (action === "nav-compact") {
    const direction = rawA;
    const currentPage = Number(rawB);
    const nextPage = direction === "next" ? currentPage + 1 : Math.max(0, currentPage - 1);
    await refreshIssueList(interaction, nextPage);
    return;
  }

  if (action === "nav-public") {
    const direction = rawA;
    const sessionId = rawB;
    const session = getDigestSession(sessionId);
    if (!session || !interaction.channel || !("send" in interaction.channel) || !("messages" in interaction.channel)) {
      await interaction.reply({ content: "digest session expired.", ephemeral: true });
      return;
    }
    const nextPage = direction === "next" ? session.page + 1 : Math.max(0, session.page - 1);
    const updated = setDigestPage(sessionId, nextPage);
    if (!updated) {
      await interaction.reply({ content: "digest session expired.", ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    logDebug("interaction.button.nav_public.defer", {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      interactionMessageId: interaction.message.id,
      sessionId,
      currentPage: session.page,
      nextPage,
      summaryMessageId: updated.summaryMessageId,
      cardMessageIds: updated.cardMessageIds,
      bottomNavMessageId: updated.bottomNavMessageId,
      itemIds: updated.itemIds
    });
    const summaryMessage = updated.summaryMessageId
      ? await interaction.channel.messages.fetch(updated.summaryMessageId).catch(() => null)
      : null;
    if (summaryMessage) {
      logDebug("interaction.button.nav_public.summary_edit.start", {
        sessionId,
        summaryMessageId: summaryMessage.id,
        page: updated.page
      });
      await summaryMessage.edit(summaryMessagePayload(updated));
      logDebug("interaction.button.nav_public.summary_edit.success", {
        sessionId,
        summaryMessageId: summaryMessage.id,
        page: updated.page
      });
    }
    const items = getItems({ guildId: interaction.guildId }).filter((item) => updated.itemIds.includes(item.id));
    await replaceSessionCards({
      session: updated,
      items,
      channel: interaction.channel,
      guild: interaction.guild
    });
    return;
  }

  const itemId = Number(rawA);
  if (!Number.isFinite(itemId)) {
    return;
  }

  if (action === "resolve") {
    logDebug("interaction.button.resolve", { itemId, guildId: interaction.guildId, userId: interaction.user.id, interactionMessageId: interaction.message.id });
    resolveItem(itemId, interaction.guildId, interaction.user.id, interaction.user.username);
    await refreshItemCard(interaction, itemId);
    return;
  }
  if (action === "reopen") {
    logDebug("interaction.button.reopen", { itemId, guildId: interaction.guildId, userId: interaction.user.id, interactionMessageId: interaction.message.id });
    reopenItem(itemId, interaction.guildId, interaction.user.id, interaction.user.username);
    await refreshItemCard(interaction, itemId);
    return;
  }
  if (action === "unsnooze") {
    logDebug("interaction.button.unsnooze", { itemId, guildId: interaction.guildId, userId: interaction.user.id, interactionMessageId: interaction.message.id });
    unsnoozeItem(itemId, interaction.guildId, interaction.user.id, interaction.user.username);
    await refreshItemCard(interaction, itemId);
    return;
  }
  if (action === "snooze") {
    logDebug("interaction.button.snooze.open_menu", { itemId, guildId: interaction.guildId, userId: interaction.user.id, interactionMessageId: interaction.message.id });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`snoozeselect:${itemId}:${interaction.message.id}`)
      .setPlaceholder("pick snooze duration")
      .addOptions(
        { label: "4 hours", value: "4h" },
        { label: "1 day", value: "1d" },
        { label: "3 days", value: "3d" },
        { label: "7 days", value: "7d" },
        { label: "Forever", value: "forever" }
      );
    await interaction.reply({ components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)], ephemeral: true });
    return;
  }
  if (action === "assign") {
    logDebug("interaction.button.assign.open_menu", { itemId, guildId: interaction.guildId, userId: interaction.user.id, interactionMessageId: interaction.message.id });
    await interaction.deferReply({ ephemeral: true });
    if (!interaction.guild) {
      await interaction.editReply({ content: "guild only action.", components: [] });
      return;
    }
    const options = await listLlamaOptions(interaction.guild);
    if (options.length === 0) {
      await interaction.editReply({ content: "no members with the llama role were found in this server.", components: [] });
      return;
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId(`assignuser:${itemId}:${interaction.message.id}`)
      .setPlaceholder("pick a llama")
      .addOptions(options);
    await interaction.editReply({ components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] });
    return;
  }
  if (action === "category") {
    logDebug("interaction.button.category.open_menu", { itemId, guildId: interaction.guildId, userId: interaction.user.id, interactionMessageId: interaction.message.id });
    const categories = getActiveCategoryNames(interaction.guildId).slice(0, 25);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`categoryselect:${itemId}:${interaction.message.id}`)
      .setPlaceholder("pick category")
      .addOptions(categories.map((category) => ({ label: category, value: category })));
    await interaction.reply({ components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)], ephemeral: true });
    return;
  }
}

function snoozeToIso(value: string): string | null {
  if (value === "forever") {
    return null;
  }
  const now = Date.now();
  const hours = value.endsWith("d") ? Number(value.slice(0, -1)) * 24 : Number(value.slice(0, -1));
  return new Date(now + hours * 3_600_000).toISOString();
}

export function registerInteractionHandler(client: Client): void {
  client.on("interactionCreate", async (interaction: Interaction) => {
    let debugRef = "interactionCreate/unknown";
    try {
      if (interaction.isChatInputCommand()) {
        debugRef = `interactionCreate/command/${interaction.commandName}`;
        logDebug("interaction.command.received", {
          commandName: interaction.commandName,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          userId: interaction.user.id
        });
        await handleCommand(interaction);
        return;
      }
      if (interaction.isButton()) {
        const [action] = parseCustomId(interaction.customId);
        debugRef = `interactionCreate/button/${action}`;
        logDebug("interaction.button.received", {
          customId: interaction.customId,
          action,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          userId: interaction.user.id,
          interactionMessageId: interaction.message.id,
          deferred: interaction.deferred,
          replied: interaction.replied
        });
        await handleButton(interaction);
        return;
      }
      if (interaction.isStringSelectMenu()) {
        const [selectAction] = parseCustomId(interaction.customId);
        debugRef = `interactionCreate/string-select/${selectAction}`;
        logDebug("interaction.string_select.received", {
          customId: interaction.customId,
          action: selectAction,
          values: interaction.values,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          userId: interaction.user.id,
          interactionMessageId: interaction.message.id,
          deferred: interaction.deferred,
          replied: interaction.replied
        });
        const [action, rawId, rawCardMessageId] = parseCustomId(interaction.customId);
        if (!interaction.guildId) {
          return;
        }
        const itemId = Number(rawId);
        if (action === "snoozeselect") {
          const untilIso = snoozeToIso(interaction.values[0]);
          snoozeItem(itemId, interaction.guildId, untilIso, interaction.user.id, interaction.user.username);
          await refreshCardMessageById(interaction, interaction.guildId, itemId, rawCardMessageId);
          await interaction.update({ content: "snoozed.", components: [] });
          return;
        }
        if (action === "categoryselect") {
          const category = recategorizeItem(itemId, interaction.guildId, interaction.values[0], interaction.user.id, interaction.user.username);
          await refreshCardMessageById(interaction, interaction.guildId, itemId, rawCardMessageId);
          await interaction.update({ content: `moved to ${category}.`, components: [] });
          return;
        }
        if (action === "assignuser") {
          if (!interaction.guildId) {
            return;
          }
          const selectedUserId = interaction.values[0];
          const member = interaction.guild ? await interaction.guild.members.fetch(selectedUserId).catch(() => null) : null;
          if (!member || !member.roles.cache.some((role) => role.name.toLowerCase() === LLAMA_ROLE_NAME)) {
            await interaction.update({ content: "that member is not a llama in this server.", components: [] });
            return;
          }
          assignItem(
            itemId,
            interaction.guildId,
            member.id,
            member.displayName,
            interaction.user.id,
            interaction.user.username
          );
          await refreshCardMessageById(interaction, interaction.guildId, itemId, rawCardMessageId);
          await interaction.update({ content: `assigned to ${member.displayName}.`, components: [] });
          return;
        }
      }
    } catch (error) {
      logError("interaction.failed", error, {
        debugRef,
        interactionType: interaction.type,
        guildId: interaction.guildId ?? null,
        channelId: "channelId" in interaction ? interaction.channelId : null,
        userId: "user" in interaction ? interaction.user.id : null,
        interactionMessageId: interaction.isMessageComponent() ? interaction.message.id : null,
        deferred: interaction.isRepliable() ? interaction.deferred : null,
        replied: interaction.isRepliable() ? interaction.replied : null
      });
      const message = error instanceof Error ? error.message : "unknown error";
      const content = `error: ${message}\ndebug ref: ${debugRef}`;
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content, ephemeral: true }).catch(() => undefined);
        } else {
          await interaction.reply({ content, ephemeral: true }).catch(() => undefined);
        }
      }
    }
  });
}
