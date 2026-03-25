import { config } from "../config";
import type { GithubEnrichment } from "../types";

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "cria-bot"
  };
  if (config.githubToken) {
    headers.Authorization = `Bearer ${config.githubToken}`;
  }
  return headers;
}

function repoLabel(owner: string, repo: string): string {
  return owner.toLowerCase() === "defillama" ? repo : `${owner}/${repo}`;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    throw new Error(`github request failed: ${response.status}`);
  }
  return response.json();
}

function commentIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = /^#issuecomment-(\d+)$/i.exec(parsed.hash);
    return match?.[1] ?? null;
  } catch {
    const match = /#issuecomment-(\d+)/i.exec(url);
    return match?.[1] ?? null;
  }
}

function commentAuthorLabel(login: string | null | undefined): string | null {
  if (!login) {
    return null;
  }
  return login.replace(/\[bot\]$/i, "").trim() || null;
}

export function extractGithubReference(url: string): { owner: string; repo: string; kind: "pull" | "commit"; ref: string } | null {
  const pullMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (pullMatch) {
    const [, owner, repo, ref] = pullMatch;
    return { owner, repo, kind: "pull", ref };
  }
  const commitMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/commit\/([a-f0-9]+)/i);
  if (commitMatch) {
    const [, owner, repo, ref] = commitMatch;
    return { owner, repo, kind: "commit", ref };
  }
  return null;
}

export async function enrichGithubUrl(url: string): Promise<GithubEnrichment | null> {
  const parsed = extractGithubReference(url);
  if (!parsed) {
    return null;
  }

  const { owner, repo, kind, ref } = parsed;

  if (kind === "pull") {
    const payload = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/pulls/${ref}`) as {
      state?: string;
      draft?: boolean;
      merged_at?: string | null;
      updated_at?: string | null;
      user?: { login?: string | null };
    };
    const status = payload.merged_at
      ? "merged"
      : payload.draft
        ? "draft"
        : payload.state ?? "open";
    const prAuthor = payload.user?.login ?? null;
    let ownerHint: string | null = null;
    const explicitCommentId = commentIdFromUrl(url);

    if (explicitCommentId) {
      const issueComment = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/issues/comments/${explicitCommentId}`) as {
        user?: { login?: string | null };
      };
      const commentAuthor = commentAuthorLabel(issueComment.user?.login);
      if (commentAuthor) {
        ownerHint = commentAuthor;
      }
    }

    if (!ownerHint) {
      const [issueComments, reviews] = await Promise.all([
        fetchJson(`https://api.github.com/repos/${owner}/${repo}/issues/${ref}/comments`) as Promise<Array<{
          user?: { login?: string | null };
          created_at?: string | null;
          updated_at?: string | null;
        }>>,
        fetchJson(`https://api.github.com/repos/${owner}/${repo}/pulls/${ref}/reviews`) as Promise<Array<{
          user?: { login?: string | null };
          submitted_at?: string | null;
        }>>
      ]);

      const candidates = [
        ...issueComments.map((comment) => ({
          login: comment.user?.login ?? null,
          ts: comment.updated_at ?? comment.created_at ?? null
        })),
        ...reviews.map((review) => ({
          login: review.user?.login ?? null,
          ts: review.submitted_at ?? null
        }))
      ]
        .filter((entry) => entry.login && entry.ts)
        .filter((entry) => entry.login !== prAuthor)
        .sort((left, right) => String(right.ts).localeCompare(String(left.ts)));

      ownerHint = commentAuthorLabel(candidates[0]?.login);
    }

    return {
      url,
      repoLabel: repoLabel(owner, repo),
      refLabel: `#${ref}`,
      status,
      lastActivityAt: payload.updated_at ?? null,
      ownerHint
    };
  }

  const payload = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/commits/${ref}`) as {
    commit?: { committer?: { date?: string | null } };
  };
  return {
    url,
    repoLabel: repoLabel(owner, repo),
    refLabel: `commit ${ref.slice(0, 7)}`,
    status: "commit",
    lastActivityAt: payload.commit?.committer?.date ?? null,
    ownerHint: null
  };
}
