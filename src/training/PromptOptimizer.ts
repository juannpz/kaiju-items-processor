import type { TrainingLogEntry } from "./TrainingLogger.ts";

interface FewShotExample {
    filename: string;
    sheetName?: string;
    headers: string[];
    columnMapping: Record<string, { target: unknown }>;
    totalRows: number;
    itemsExtracted: number;
    success: boolean;
    timestamp: string;
    score: number;
}

interface ColumnPattern {
    columnName: string;
    mappedField: string;
    confidence: number;
    occurrences: number;
}

export class PromptOptimizer {
    private basePath: string;
    private examples: FewShotExample[] = [];
    private patterns: ColumnPattern[] = [];
    private lastLoadTime = 0;
    private refreshIntervalMs: number;
    private maxExamples = 50;
    private static instance: PromptOptimizer | null = null;

    private constructor(basePath: string, refreshIntervalMs: number) {
        this.basePath = basePath;
        this.refreshIntervalMs = refreshIntervalMs;
    }

    static init(basePath?: string, refreshIntervalMs = 15 * 60 * 1000): PromptOptimizer {
        if (!this.instance) {
            const path = basePath || Deno.env.get("TRAINING_DATA_PATH") || "";
            this.instance = new PromptOptimizer(path, refreshIntervalMs);
        }
        return this.instance;
    }

    static getInstance(): PromptOptimizer | null {
        return this.instance;
    }

    async loadLogs(): Promise<void> {
        if (!this.basePath) return;
        const now = Date.now();
        if (now - this.lastLoadTime < this.refreshIntervalMs && this.examples.length > 0) {
            return;
        }

        try {
            const dir = `${this.basePath}/logs`;
            const entries: FewShotExample[] = [];

            for await (const entry of Deno.readDir(dir)) {
                if (!entry.name.endsWith(".json")) continue;
                if (entries.length >= this.maxExamples * 2) break;

                try {
                    const content = await Deno.readTextFile(`${dir}/${entry.name}`);
                    const log: TrainingLogEntry = JSON.parse(content);

                    if (!log.success || !log.columnMapping) continue;
                    if (log.totalRows === 0) continue;
                    const nameMissing = log.missingFields.some(
                        (mf) => mf.field === "name" && mf.affectedItems > 0,
                    );
                    if (nameMissing) continue;
                    const extractionRate = log.itemsExtracted / log.totalRows;
                    if (extractionRate < 0.5) continue;
                    if (!log.headers || log.headers.length === 0) continue;

                    const mapping = log.columnMapping as Record<string, { target: unknown }>;
                    const mappedCount = Object.values(mapping).filter(
                        (v) => v && v.target !== null,
                    ).length;

                    if (mappedCount === 0) continue;

                    entries.push({
                        filename: log.filename,
                        sheetName: log.sheetName,
                        headers: log.headers,
                        columnMapping: mapping,
                        totalRows: log.totalRows,
                        itemsExtracted: log.itemsExtracted,
                        success: log.success,
                        timestamp: log.timestamp,
                        score: 0,
                    });
                } catch {
                    // Skip corrupted files
                }
            }

            this.examples = this.selectBestExamples(entries);
            this.patterns = this.extractPatterns(this.examples);
            this.lastLoadTime = now;
        } catch {
            // Non-blocking - fall back to defaults
        }
    }

    buildFewShotPrompt(): string {
        if (this.examples.length === 0) return "";

        const selected = this.examples.slice(0, 3);

        let prompt =
            "\n\n---\nEJEMPLOS DE MAPEOS EXITOSOS PREVIOS (usa estos patrones como referencia):\n\n";

        for (let i = 0; i < selected.length; i++) {
            const ex = selected[i];
            const sheetInfo = ex.sheetName ? ` (hoja: ${ex.sheetName})` : "";

            prompt += `Ejemplo ${
                i + 1
            }: Archivo "${ex.filename}"${sheetInfo} — ${ex.totalRows} filas, ${ex.itemsExtracted} items extraídos.\n`;
            prompt += `Headers: ${ex.headers.join(", ")}\n`;
            prompt += `Mapeo:\n`;

            for (const [col, def] of Object.entries(ex.columnMapping)) {
                if (!def || def.target === null) continue;
                const target = typeof def.target === "string"
                    ? def.target
                    : JSON.stringify(def.target);
                prompt += `  "${col}" → ${target}\n`;
            }
            prompt += "\n";
        }

        if (this.patterns.length > 0) {
            prompt += "PATRONES COMUNES DETECTADOS (alta confianza):\n";
            for (const p of this.patterns.slice(0, 6)) {
                prompt += `  "${p.columnName}" → "${p.mappedField}" (${
                    Math.round(p.confidence * 100)
                }% de ${p.occurrences} casos)\n`;
            }
        }

        prompt +=
            "\nUsá estos patrones como guía, pero siempre priorizá los valores reales de la planilla actual.\n";

        return prompt;
    }

    getStats(): {
        examplesLoaded: number;
        patternsFound: number;
        lastRefresh: string;
        avgItemsExtracted: number;
    } {
        const avgItems = this.examples.length > 0
            ? Math.round(
                this.examples.reduce((sum, e) => sum + e.itemsExtracted, 0) / this.examples.length,
            )
            : 0;

        return {
            examplesLoaded: this.examples.length,
            patternsFound: this.patterns.length,
            lastRefresh: new Date(this.lastLoadTime).toISOString(),
            avgItemsExtracted: avgItems,
        };
    }

    async manualRefresh(): Promise<void> {
        this.lastLoadTime = 0;
        await this.loadLogs();
    }

    private selectBestExamples(entries: FewShotExample[]): FewShotExample[] {
        const seenHeaders = new Set<string>();

        const scored = entries
            .filter((e) => {
                const key = [...e.headers].sort().join(",").toLowerCase();
                if (seenHeaders.has(key)) return false;
                seenHeaders.add(key);
                return true;
            })
            .map((e) => {
                const ageHours = (Date.now() - new Date(e.timestamp).getTime()) / (1000 * 60 * 60);
                const recencyScore = Math.max(0, 1 - ageHours / (24 * 30));
                const complexityScore = Math.min(1, e.headers.length / 15);
                const successScore = e.success ? 1 : 0.5;
                e.score = recencyScore * 0.4 + complexityScore * 0.3 + successScore * 0.3;
                return e;
            })
            .sort((a, b) => b.score - a.score);

        return scored.slice(0, this.maxExamples);
    }

    private extractPatterns(examples: FewShotExample[]): ColumnPattern[] {
        const patternMap = new Map<string, { field: string; count: number }>();

        for (const ex of examples) {
            for (const [col, def] of Object.entries(ex.columnMapping)) {
                if (!def || def.target === null) continue;
                if (typeof def.target !== "string") continue;

                const key = col.toLowerCase().trim();
                const existing = patternMap.get(key);

                if (existing) {
                    if (existing.field === def.target) {
                        existing.count++;
                    }
                } else {
                    patternMap.set(key, { field: def.target, count: 1 });
                }
            }
        }

        const patterns: ColumnPattern[] = [];
        for (const [col, data] of patternMap) {
            const total = this.countColumnOccurrences(col, examples);
            patterns.push({
                columnName: col,
                mappedField: data.field,
                confidence: total > 0 ? data.count / total : 0,
                occurrences: data.count,
            });
        }

        return patterns
            .filter((p) => p.confidence >= 0.5 && p.occurrences >= 2)
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 20);
    }

    private countColumnOccurrences(col: string, examples: FewShotExample[]): number {
        const lower = col.toLowerCase().trim();
        return examples.filter((e) => e.headers.some((h) => h.toLowerCase().trim() === lower))
            .length;
    }
}
