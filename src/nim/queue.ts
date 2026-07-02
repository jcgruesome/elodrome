export class RateLimiter {
  private reservations = new Map<string, number[]>()

  constructor(
    private maxPerMinute: number,
    private now: () => number = Date.now,
  ) {}

  /** Returns ms to wait before sending, and reserves the slot. */
  take(modelId: string): number {
    const t = this.now()
    const recent = (this.reservations.get(modelId) ?? []).filter((x) => x > t - 60_000)
    const wait = recent.length < this.maxPerMinute
      ? 0
      : (recent[0] ?? t) + 60_000 - t
    this.reservations.set(modelId, [...recent, t + wait])
    return wait
  }

  async acquire(modelId: string): Promise<void> {
    const wait = this.take(modelId)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }
}
