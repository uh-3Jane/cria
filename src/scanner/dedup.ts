import type { FetchedMessage, LlmIssueCandidate } from "../types";
import { extractGithubPullKey, isIssueSignalText, isWeakFollowUpText, likelySameTopic } from "../utils/text";

export interface NormalizedCandidate extends LlmIssueCandidate {
  allMessageIds: string[];
}

function selectPrimaryCandidate(
  candidates: NormalizedCandidate[],
  messagesById: Map<string, FetchedMessage>
): NormalizedCandidate {
  const byNewest = candidates
    .slice()
    .sort((a, b) => {
      const left = messagesById.get(a.message_id)?.createdAt ?? "";
      const right = messagesById.get(b.message_id)?.createdAt ?? "";
      return right.localeCompare(left);
    });

  const issueLike = byNewest.find((candidate) => {
    const message = messagesById.get(candidate.message_id);
    return isIssueSignalText(`${candidate.summary} ${message?.content ?? ""}`);
  });
  if (issueLike) {
    return issueLike;
  }

  const strong = byNewest.find((candidate) => {
    const message = messagesById.get(candidate.message_id);
    return !isWeakFollowUpText(`${candidate.summary} ${message?.content ?? ""}`);
  });
  return strong ?? byNewest[0];
}

export function groupWithinScan(candidates: LlmIssueCandidate[], messagesById: Map<string, FetchedMessage>): NormalizedCandidate[] {
  const normalized: NormalizedCandidate[] = candidates.map((candidate) => ({
    ...candidate,
    allMessageIds: Array.from(new Set([candidate.message_id, ...(candidate.related_message_ids ?? [])]))
  }));

  const consumed = new Set<number>();
  const grouped: NormalizedCandidate[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    if (consumed.has(index)) {
      continue;
    }
    const current = normalized[index];
    const currentMessage = messagesById.get(current.message_id);
    const merged = [current];
    consumed.add(index);

    for (let otherIndex = index + 1; otherIndex < normalized.length; otherIndex += 1) {
      if (consumed.has(otherIndex)) {
        continue;
      }
      const other = normalized[otherIndex];
      if (current.user_id !== other.user_id || current.category !== other.category) {
        continue;
      }
      const otherMessage = messagesById.get(other.message_id);
      const left = `${current.summary} ${currentMessage?.content ?? ""}`;
      const right = `${other.summary} ${otherMessage?.content ?? ""}`;
      if (!likelySameTopic(left, right)) {
        continue;
      }
      merged.push(other);
      consumed.add(otherIndex);
    }

    const primary = selectPrimaryCandidate(merged, messagesById);

    grouped.push({
      ...primary,
      urgency: merged.some((item) => item.urgency === "high")
        ? "high"
        : merged.some((item) => item.urgency === "medium")
          ? "medium"
          : "low",
      allMessageIds: Array.from(new Set(merged.flatMap((item) => item.allMessageIds))),
      related_message_ids: Array.from(new Set(merged.flatMap((item) => item.allMessageIds))).filter((id) => id !== primary.message_id)
    });
  }

  return grouped;
}

export function groupAcrossScan(candidates: NormalizedCandidate[], messagesById: Map<string, FetchedMessage>): NormalizedCandidate[] {
  const consumed = new Set<number>();
  const grouped: NormalizedCandidate[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    if (consumed.has(index)) {
      continue;
    }
    const current = candidates[index];
    const merged = [current];
    const currentMessage = messagesById.get(current.message_id);
    consumed.add(index);

    for (let otherIndex = index + 1; otherIndex < candidates.length; otherIndex += 1) {
      if (consumed.has(otherIndex)) {
        continue;
      }
      const other = candidates[otherIndex];
      const otherMessage = messagesById.get(other.message_id);
      const left = `${current.summary} ${currentMessage?.content ?? ""}`;
      const right = `${other.summary} ${otherMessage?.content ?? ""}`;
      const samePull = Boolean(extractGithubPullKey(left) && extractGithubPullKey(left) === extractGithubPullKey(right));
      const sameAuthor = current.user_id === other.user_id;
      const sameTopic = likelySameTopic(left, right);
      const sameReference = sameTopic;
      if (current.category !== other.category && !samePull && !(sameAuthor && sameTopic)) {
        continue;
      }
      if (!sameAuthor && !sameReference && !samePull) {
        continue;
      }
      if (!sameTopic) {
        continue;
      }
      merged.push(other);
      consumed.add(otherIndex);
    }

    const primary = selectPrimaryCandidate(merged, messagesById);

    grouped.push({
      ...primary,
      urgency: merged.some((item) => item.urgency === "high")
        ? "high"
        : merged.some((item) => item.urgency === "medium")
          ? "medium"
          : "low",
      allMessageIds: Array.from(new Set(merged.flatMap((item) => item.allMessageIds))),
      related_message_ids: Array.from(new Set(merged.flatMap((item) => item.allMessageIds))).filter((id) => id !== primary.message_id)
    });
  }

  return grouped;
}
