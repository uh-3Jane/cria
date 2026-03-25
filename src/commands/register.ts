import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { config } from "../config";

export function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName("scan")
      .setDescription("scan channels for unresolved issues")
      .addStringOption((option) => option.setName("period").setDescription("6h, 48h, 7d")),
    new SlashCommandBuilder()
      .setName("issues")
      .setDescription("show current outstanding issues"),
    new SlashCommandBuilder()
      .setName("issue")
      .setDescription("issue actions")
      .addSubcommand((sub) =>
        sub
          .setName("category")
          .setDescription("change issue category")
          .addIntegerOption((option) => option.setName("id").setRequired(true).setDescription("item id"))
          .addStringOption((option) => option.setName("category").setRequired(true).setDescription("category name"))
      ),
    new SlashCommandBuilder().setName("reopen").setDescription("reopen an item").addIntegerOption((option) => option.setName("id").setRequired(true).setDescription("item id")),
    new SlashCommandBuilder().setName("unsnooze").setDescription("cancel a snooze").addIntegerOption((option) => option.setName("id").setRequired(true).setDescription("item id")),
    new SlashCommandBuilder().setName("snoozed").setDescription("list snoozed items"),
    new SlashCommandBuilder().setName("resolved").setDescription("show recently resolved issues"),
    new SlashCommandBuilder()
      .setName("config")
      .setDescription("bot configuration")
      .addSubcommand((sub) => sub.setName("status").setDescription("show config status"))
      .addSubcommand((sub) => sub.setName("lookback").setDescription("set default lookback").addStringOption((option) => option.setName("duration").setRequired(true).setDescription("24h, 7d")))
      .addSubcommand((sub) =>
        sub
          .setName("emissions-set")
          .setDescription("set scan emissions channel")
          .addChannelOption((option) => option.setName("channel").setRequired(true).setDescription("channel for scan results"))
      )
      .addSubcommand((sub) => sub.setName("emissions-show").setDescription("show scan emissions channel"))
      .addSubcommand((sub) => sub.setName("emissions-clear").setDescription("clear scan emissions channel"))
      .addSubcommand((sub) => sub.setName("chat-on").setDescription("enable chatbot mentions"))
      .addSubcommand((sub) => sub.setName("chat-off").setDescription("disable chatbot mentions"))
      .addSubcommand((sub) =>
        sub
          .setName("chat-add-channel")
          .setDescription("allow chatbot in a channel")
          .addChannelOption((option) => option.setName("channel").setRequired(true).setDescription("allowed chat channel"))
      )
      .addSubcommand((sub) =>
        sub
          .setName("chat-remove-channel")
          .setDescription("remove chatbot from a channel")
          .addChannelOption((option) => option.setName("channel").setRequired(true).setDescription("allowed chat channel"))
      )
      .addSubcommand((sub) => sub.setName("chat-list").setDescription("list chatbot channels")),
    new SlashCommandBuilder()
      .setName("admin")
      .setDescription("admin controls")
      .addSubcommand((sub) => sub.setName("add").setDescription("add admin").addUserOption((option) => option.setName("user").setRequired(true).setDescription("user")))
      .addSubcommand((sub) => sub.setName("remove").setDescription("remove admin").addUserOption((option) => option.setName("user").setRequired(true).setDescription("user")))
      .addSubcommand((sub) => sub.setName("list").setDescription("list admins"))
      .addSubcommand((sub) => sub.setName("audit").setDescription("show recent audit log")),
    new SlashCommandBuilder()
      .setName("category")
      .setDescription("category controls")
      .addSubcommand((sub) => sub.setName("list").setDescription("list categories"))
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("add category")
          .addStringOption((option) => option.setName("name").setRequired(true).setDescription("category name"))
      )
      .addSubcommand((sub) =>
        sub
          .setName("rename")
          .setDescription("rename category")
          .addStringOption((option) => option.setName("old").setRequired(true).setDescription("current category"))
          .addStringOption((option) => option.setName("new").setRequired(true).setDescription("new category"))
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("remove category")
          .addStringOption((option) => option.setName("name").setRequired(true).setDescription("category name"))
      )
      .addSubcommandGroup((group) =>
        group
          .setName("assignees")
          .setDescription("category default assignees")
          .addSubcommand((sub) =>
            sub
              .setName("add")
              .setDescription("add category assignee")
              .addStringOption((option) => option.setName("category").setRequired(true).setDescription("category name"))
              .addUserOption((option) => option.setName("user").setRequired(true).setDescription("user"))
          )
          .addSubcommand((sub) =>
            sub
              .setName("remove")
              .setDescription("remove category assignee")
              .addStringOption((option) => option.setName("category").setRequired(true).setDescription("category name"))
              .addUserOption((option) => option.setName("user").setRequired(true).setDescription("user"))
          )
          .addSubcommand((sub) =>
            sub
              .setName("list")
              .setDescription("list category assignees")
              .addStringOption((option) => option.setName("category").setRequired(true).setDescription("category name"))
          )
      ),
    new SlashCommandBuilder()
      .setName("cria")
      .setDescription("about cria")
      .addSubcommand((sub) => sub.setName("list").setDescription("show command list"))
  ].map((command) => command.toJSON());
}

export async function registerCommands(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  if (config.guildId) {
    await rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), { body: buildCommands() });
    return;
  }
  await rest.put(Routes.applicationCommands(config.applicationId), { body: buildCommands() });
}
