import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Strategy } from "@zyo/shared";

/**
 * Small JSON-file strategy store with atomic writes.
 * Deliberately boring: v1 runs a single agent process; swap for Postgres
 * when the agent becomes multi-instance.
 */
export class StrategyStore {
  private cache: Map<string, Strategy> | null = null;

  constructor(private readonly path: string) {}

  private async load(): Promise<Map<string, Strategy>> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, "utf8");
      const list = JSON.parse(raw) as Strategy[];
      this.cache = new Map(list.map((s) => [s.id, s]));
    } catch {
      this.cache = new Map();
    }
    return this.cache;
  }

  private async persist(): Promise<void> {
    if (!this.cache) return;
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify([...this.cache.values()], null, 2));
    await rename(tmp, this.path);
  }

  async list(): Promise<Strategy[]> {
    return [...(await this.load()).values()];
  }

  async get(id: string): Promise<Strategy | undefined> {
    return (await this.load()).get(id);
  }

  async upsert(strategy: Strategy): Promise<void> {
    const map = await this.load();
    map.set(strategy.id, { ...strategy, updatedAt: new Date().toISOString() });
    await this.persist();
  }

  async update(id: string, patch: Partial<Strategy>): Promise<Strategy> {
    const map = await this.load();
    const existing = map.get(id);
    if (!existing) throw new Error(`strategy ${id} not found`);
    const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    map.set(id, next);
    await this.persist();
    return next;
  }
}
