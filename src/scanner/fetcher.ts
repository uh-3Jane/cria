import {
  ChannelType,
  type Guild,
  type Message
} from "discord.js";
import type { ChannelScanCursorRow, FetchedMessage } from "../types";
import { logDebug } from "../utils/logger";

const CONTEXT_TAIL_SIZE = 2;
const INCREMENTAL_RECENT_TAIL_SIZE = 25;

function canScanChannel(channel: { type: ChannelType }): boolean {
  const type = channel.type;
  return (
    type === ChannelType.GuildText ||
    type === ChannelType.GuildAnnouncement ||
    type === ChannelType.PublicThread
  );
}

function sortMessages(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function sortMessagesDesc(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
}

export async function fetchGuildMessages(
  guild: Guild,
  lookbackHours: number,
  channelOnlyId?: string,
  cursors?: Map<string, ChannelScanCursorRow>,
  onChannelProgress?: (current: number, total: number, channelLabel: string) => Promise<void> | void
): Promise<{ messages: FetchedMessage[]; channelsScanned: number; skippedChannels: string[] }> {
  const cutoff = Date.now() - lookbackHours * 3_600_000;
  const channels = await guild.channels.fetch();
  const textChannels = channels
    .filter((channel): channel is NonNullable<typeof channel> => Boolean(channel))
    .filter((channel) => channel.isTextBased())
    .filter((channel) => canScanChannel(channel))
    .filter((channel) => !channelOnlyId || channel.id === channelOnlyId);

  const results: FetchedMessage[] = [];
  const skippedChannels: string[] = [];

  logDebug("scan.fetch.start", {
    guildId: guild.id,
    lookbackHours,
    cutoff: new Date(cutoff).toISOString(),
    channelOnlyId: channelOnlyId ?? "all"
  });

  let scannedCount = 0;
  for (const channel of textChannels.values()) {
    if (!("messages" in channel)) {
      continue;
    }
    scannedCount += 1;
    await onChannelProgress?.(
      scannedCount,
      textChannels.size,
      "name" in channel && channel.name ? channel.name : channel.id
    );
    try {
      const cursor = cursors?.get(channel.id);
      const canUseCursor = Boolean(
        cursor && Date.parse(cursor.latest_message_created_at) >= cutoff
      );
      logDebug("scan.fetch.channel.start", {
        channelId: channel.id,
        channelName: "name" in channel && channel.name ? channel.name : channel.id,
        usingCursor: canUseCursor,
        cursorMessageId: cursor?.latest_message_id ?? null
      });

      const collected: Message[] = [];

      if (canUseCursor && cursor) {
        let after = cursor.latest_message_id;
        while (true) {
          const page = await channel.messages.fetch({ limit: 100, after });
          if (page.size === 0) {
            break;
          }
          const orderedAsc = sortMessages([...page.values()]);
          for (const message of orderedAsc) {
            if (message.createdTimestamp >= cutoff) {
              collected.push(message);
            }
          }
          const newest = orderedAsc[orderedAsc.length - 1];
          if (!newest || newest.id === after || page.size < 100) {
            break;
          }
          after = newest.id;
        }

        if (collected.length > 0) {
          const oldestNew = sortMessages(collected)[0];
          if (oldestNew) {
            const contextTailPage = await channel.messages.fetch({ limit: CONTEXT_TAIL_SIZE, before: oldestNew.id }).catch(() => null);
            if (contextTailPage) {
              const contextTail = sortMessages([...contextTailPage.values()]).filter((message) => {
                return !message.author.bot && message.createdTimestamp >= cutoff;
              });
              collected.unshift(...contextTail);
            }
          }
        }

        const recentTailPage = await channel.messages.fetch({ limit: INCREMENTAL_RECENT_TAIL_SIZE }).catch(() => null);
        if (recentTailPage) {
          const recentTail = [...recentTailPage.values()].filter((message) => message.createdTimestamp >= cutoff);
          collected.push(...recentTail);
        }
      } else {
        let before: string | undefined;
        while (true) {
          const page = await channel.messages.fetch({ limit: 100, before });
          if (page.size === 0) {
            break;
          }
          const orderedDesc = sortMessagesDesc([...page.values()]);
          for (const message of orderedDesc) {
            if (message.createdTimestamp < cutoff) {
              break;
            }
            collected.push(message);
          }
          const oldest = orderedDesc[orderedDesc.length - 1];
          if (!oldest || oldest.createdTimestamp < cutoff) {
            break;
          }
          before = oldest.id;
        }
      }

      const filtered = collected
        .filter((message) => !message.author.bot)
        .filter((message) => message.content.trim().length >= 5);

      const ordered = sortMessages(
        Array.from(new Map(filtered.map((message) => [message.id, message])).values())
      );
      for (let index = 0; index < ordered.length; index += 1) {
        const message = ordered[index];
        const beforeContext = ordered.slice(Math.max(0, index - 2), index).map((m) => `${m.author.username}: ${m.content}`);
        const afterContext = ordered.slice(index + 1, index + 3).map((m) => `${m.author.username}: ${m.content}`);
        results.push({
          guildId: guild.id,
          guildName: guild.name,
          channelId: channel.id,
          channelName: "name" in channel && channel.name ? channel.name : channel.id,
          messageId: message.id,
          messageUrl: message.url,
          authorId: message.author.id,
          authorName: message.author.username,
          content: message.content,
          createdAt: message.createdAt.toISOString(),
          contextBefore: beforeContext,
          contextAfter: afterContext
        });
      }
      logDebug("scan.fetch.channel.success", {
        channelId: channel.id,
        yielded: ordered.length
      });
    } catch (error) {
      skippedChannels.push(channel.id);
      logDebug("scan.fetch.channel.skipped", { channelId: channel.id, error: String(error) });
    }
  }

  logDebug("scan.fetch.done", {
    guildId: guild.id,
    totalMessages: results.length,
    channelsScanned: textChannels.size,
    skippedChannels: skippedChannels.length
  });

  return {
    messages: results,
    channelsScanned: textChannels.size,
    skippedChannels
  };
}
