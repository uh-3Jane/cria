import { Client, GatewayIntentBits, Partials } from "discord.js";
import { config } from "./config";
import { migrate } from "./db/schema";
import { registerCommands } from "./commands/register";
import { registerInteractionHandler } from "./events/interactionCreate";
import { registerMessageCreateHandler } from "./events/messageCreate";
import { registerReadyHandler } from "./events/ready";
import { syncReviewQueueFromLearningFeedback } from "./review/store";

await registerCommands();
migrate();
syncReviewQueueFromLearningFeedback(config.guildId);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

registerReadyHandler(client);
registerInteractionHandler(client);
registerMessageCreateHandler(client);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[cria] received ${signal}, shutting down`);
  await client.destroy();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await client.login(config.discordToken);
