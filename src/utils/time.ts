export function hoursFromPeriod(period?: string | null): number {
  if (!period) {
    return 24;
  }
  const value = period.trim().toLowerCase();
  const match = /^(\d+)(h|d)$/.exec(value);
  if (!match) {
    throw new Error("period must look like 6h, 48h, or 7d");
  }
  const amount = Number(match[1]);
  return match[2] === "d" ? amount * 24 : amount;
}

export function ageLabel(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(delta / 3_600_000);
  if (hours < 1) {
    const minutes = Math.max(1, Math.floor(delta / 60_000));
    return `${minutes}m ago`;
  }
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
