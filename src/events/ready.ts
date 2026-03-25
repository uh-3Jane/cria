import type { Client } from "discord.js";
import { config } from "../config";
import { recoverStaleScans } from "../issues/store";
import { logInfo } from "../utils/logger";

export function registerReadyHandler(client: Client): void {
  client.once("clientReady", () => {
    const recovered = recoverStaleScans(config.staleScanMinutes);
    if (recovered > 0) {
      logInfo("bot.startup.recovered_stale_scans", { recovered });
    }
    logInfo("bot.ready", { userTag: client.user?.tag ?? null });
  });
}
