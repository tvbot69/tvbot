export class Statistics {
  private static counters: Map<string, number> = new Map();

  public static inc(name: string, amount: number = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  public static snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }
}
