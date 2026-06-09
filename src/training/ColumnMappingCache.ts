import type { LLMColumnMappingResponse } from "../mapping/types.ts";

interface CacheEntry {
    mapping: LLMColumnMappingResponse;
    cachedAt: string;
    filename: string;
    rowCount: number;
    headers: string[];
    hitCount: number;
}

export class ColumnMappingCache {
    private basePath: string;
    private maxAgeDays: number;
    private static instance: ColumnMappingCache | null = null;

    private constructor(basePath: string, maxAgeDays: number) {
        this.basePath = basePath;
        this.maxAgeDays = maxAgeDays;
    }

    static init(basePath?: string, maxAgeDays = 30): ColumnMappingCache {
        if (!this.instance) {
            const path = basePath || Deno.env.get("TRAINING_DATA_PATH") || "";
            this.instance = new ColumnMappingCache(path, maxAgeDays);
        }
        return this.instance;
    }

    static getInstance(): ColumnMappingCache | null {
        return this.instance;
    }

    getCacheKey(headers: string[], sampleValues: string[]): string {
        const normalized = [...headers]
            .map((h) => h.toLowerCase().trim())
            .sort()
            .join(",");

        const sample = sampleValues.slice(0, 3).join("|").slice(0, 120);
        return `${normalized}::${sample}`;
    }

    async get(headers: string[], sampleValues: string[]): Promise<LLMColumnMappingResponse | null> {
        if (!this.basePath) return null;

        const key = this.getCacheKey(headers, sampleValues);

        try {
            const filePath = `${this.basePath}/cache/${key}.json`;
            const content = await Deno.readTextFile(filePath);

            const entry: CacheEntry = JSON.parse(content);

            const ageMs = Date.now() - new Date(entry.cachedAt).getTime();
            const maxAgeMs = this.maxAgeDays * 24 * 60 * 60 * 1000;

            if (ageMs > maxAgeMs) return null;

            entry.hitCount += 1;
            await Deno.writeTextFile(filePath, JSON.stringify(entry, null, 2));

            return entry.mapping;
        } catch {
            return null;
        }
    }

    async set(
        headers: string[],
        mapping: LLMColumnMappingResponse,
        filename: string,
        rowCount: number,
    ): Promise<void> {
        if (!this.basePath) return;

        try {
            const dir = `${this.basePath}/cache`;
            await Deno.mkdir(dir, { recursive: true });

            const key = this.getCacheKey(headers, headers);

            const entry: CacheEntry = {
                mapping,
                cachedAt: new Date().toISOString(),
                filename,
                rowCount,
                headers,
                hitCount: 0,
            };

            const filePath = `${dir}/${key}.json`;
            await Deno.writeTextFile(filePath, JSON.stringify(entry, null, 2));
        } catch {
            // Non-blocking
        }
    }

    async getStats(): Promise<{
        totalCached: number;
        totalHits: number;
        entries: Array<{ headers: string[]; filename: string; cachedAt: string; hitCount: number }>;
    }> {
        try {
            const dir = `${this.basePath}/cache`;
            const entries: Array<{
                headers: string[];
                filename: string;
                cachedAt: string;
                hitCount: number;
            }> = [];
            let totalHits = 0;

            for await (const entry of Deno.readDir(dir)) {
                if (!entry.name.endsWith(".json")) continue;

                try {
                    const content = await Deno.readTextFile(`${dir}/${entry.name}`);
                    const cached: CacheEntry = JSON.parse(content);

                    entries.push({
                        headers: cached.headers,
                        filename: cached.filename,
                        cachedAt: cached.cachedAt,
                        hitCount: cached.hitCount,
                    });
                    totalHits += cached.hitCount;
                } catch {
                    // Skip corrupted files
                }
            }

            return {
                totalCached: entries.length,
                totalHits,
                entries: entries.sort(
                    (a, b) => new Date(b.cachedAt).getTime() - new Date(a.cachedAt).getTime(),
                ),
            };
        } catch {
            return { totalCached: 0, totalHits: 0, entries: [] };
        }
    }
}
