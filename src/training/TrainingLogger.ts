import type { TargetSchema } from "../types.ts";

export interface TrainingLogEntry {
    version: string;
    timestamp: string;
    filename: string;
    format: string;
    model: string;
    sheetName?: string;
    totalRows: number;
    headers: string[];
    sampleRows: Array<Record<string, unknown>>;
    schema: TargetSchema;
    columnMapping: Record<string, unknown> | null;
    itemsExtracted: number;
    missingFields: Array<{ field: string; reason: string; affectedItems: number }>;
    warnings: Array<{ type: string; field: string; message: string }>;
    tokensUsed: number;
    processingTimeMs: number;
    success: boolean;
    errorMessage?: string;
}

export class TrainingLogger {
    private basePath: string;
    private static instance: TrainingLogger | null = null;

    private constructor(basePath: string) {
        this.basePath = basePath;
    }

    static init(basePath?: string): TrainingLogger {
        if (!this.instance) {
            const path = basePath || Deno.env.get("TRAINING_DATA_PATH") || "";
            this.instance = new TrainingLogger(path);
        }
        return this.instance;
    }

    static getInstance(): TrainingLogger | null {
        return this.instance;
    }

    async log(entry: TrainingLogEntry): Promise<void> {
        if (!this.basePath) return;

        try {
            const dir = `${this.basePath}/logs`;
            await Deno.mkdir(dir, { recursive: true });

            const date = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            const safeName = (entry.filename || "unknown")
                .replace(/[^a-zA-Z0-9]/g, "_")
                .slice(0, 40);
            const hash = await this.simpleHash(
                JSON.stringify(entry.headers) + entry.totalRows,
            );

            const fileName = `${date}_${safeName}_${hash}.json`;
            const filePath = `${dir}/${fileName}`;

            const content = JSON.stringify(entry, null, 2);

            await Deno.writeTextFile(filePath, content);
        } catch {
            // Non-blocking — log failures are silent
        }
    }

    private async simpleHash(input: string): Promise<string> {
        const data = new TextEncoder().encode(input);
        const hashBuffer = await crypto.subtle.digest("SHA-256", data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
    }
}
