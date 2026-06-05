import type {
    DocumentInput,
    MissingField,
    ProcessInput,
    ProcessMeta,
    ProcessorConfig,
    ProcessResult,
    Warning,
} from "./types.ts";
import type { RawContent, TabularData } from "./parsers/types.ts";
import { detectFormat, getParser } from "./parsers/index.ts";
import { buildSystemPrompt } from "./llm/prompts.ts";
import { buildToolParameters } from "./schema.ts";
import { LLMClient, LLMError } from "./llm/LLMClient.ts";
import { formatForLLM } from "./utils/contentFormatter.ts";
import { coerceValue } from "./utils/typeCoercion.ts";
import type { SchemaField } from "./types.ts";

const DEFAULT_LLM_TIMEOUT_MS = 120_000;

export class DocumentProcessor {
    private schema: ProcessorConfig["schema"];
    private llmClient: LLMClient;
    private locale: string;
    private timeoutMs: number;

    constructor(config: ProcessorConfig) {
        this.schema = config.schema;
        this.llmClient = new LLMClient(config.llm);
        this.locale = config.locale ?? "es";
        this.timeoutMs = DEFAULT_LLM_TIMEOUT_MS;
    }

    async process<T extends Record<string, unknown> = Record<string, unknown>>(
        input: ProcessInput,
    ): Promise<ProcessResult<T>> {
        const startTime = Date.now();

        const documentBytes = this.resolveDocument(input.document);

        const resolvedFormat = input.format && input.format !== "auto"
            ? input.format
            : detectFormat(documentBytes, input.filename);

        const parser = getParser(resolvedFormat, documentBytes, input.filename);
        const rawContent: RawContent = await parser.parse(documentBytes);

        const sourceType = resolvedFormat;
        let totalRowsFound = 0;

        if (rawContent.type === "tabular") {
            totalRowsFound = (rawContent.data as TabularData).totalRows;
        }

        if (totalRowsFound === 0 && rawContent.type === "tabular") {
            return {
                items: [] as T[],
                missingFields: [],
                warnings: [],
                meta: {
                    sourceType,
                    totalRowsFound: 0,
                    itemsExtracted: 0,
                    processingTimeMs: Date.now() - startTime,
                },
            };
        }

        const formattedContent = formatForLLM(rawContent);
        const systemPrompt = buildSystemPrompt(this.schema, this.locale);
        const toolParameters = buildToolParameters(this.schema);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        let llmResult;
        let tokensUsed = 0;

        try {
            const response = await this.llmClient.extract(
                systemPrompt,
                formattedContent,
                toolParameters,
                controller.signal,
            );
            llmResult = response.result;
            tokensUsed = response.tokensUsed;
        } catch (error) {
            clearTimeout(timeoutId);
            if (error instanceof LLMError) throw error;
            if (error instanceof DOMException && error.name === "AbortError") {
                throw new LLMError("LLM request timed out", 408);
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }

        const processedItems = this.postProcessItems<T>(llmResult.items);
        const processedWarnings = this.postProcessWarnings(llmResult.warnings);

        const enrichedMissingFields = this.enrichMissingFields(
            llmResult.missing_fields,
            processedItems,
        );

        const meta: ProcessMeta = {
            sourceType,
            totalRowsFound,
            itemsExtracted: processedItems.length,
            llmTokensUsed: tokensUsed,
            processingTimeMs: Date.now() - startTime,
        };

        return {
            items: processedItems,
            missingFields: enrichedMissingFields,
            warnings: processedWarnings,
            meta,
        };
    }

    private resolveDocument(input: DocumentInput): Uint8Array {
        if (input instanceof Uint8Array) return input;

        if (typeof input === "string") {
            if (input.startsWith("data:")) {
                const base64 = input.split(",")[1] ?? input;
                return this.base64ToBytes(base64);
            }
            return this.base64ToBytes(input);
        }

        throw new Error("Invalid document input: must be Uint8Array or base64 string");
    }

    private base64ToBytes(base64: string): Uint8Array {
        try {
            const binaryString = atob(base64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            return bytes;
        } catch {
            throw new Error("Invalid base64 string provided as document input");
        }
    }

    private postProcessItems<T extends Record<string, unknown>>(
        items: Record<string, unknown>[],
    ): T[] {
        return items.map((item) => {
            const processed: Record<string, unknown> = {};

            for (const field of this.schema.fields) {
                const rawValue = item[field.name];

                if (rawValue === undefined || rawValue === null) {
                    if (field.required) {
                        processed[field.name] = undefined;
                    }
                    continue;
                }

                processed[field.name] = this.coerceField(field, rawValue);
            }

            for (const key of Object.keys(item)) {
                if (!(key in processed)) {
                    processed[key] = item[key];
                }
            }

            return processed as T;
        });
    }

    private coerceField(field: SchemaField, value: unknown): unknown {
        if (field.type === "array") {
            if (Array.isArray(value)) {
                return value.map((item) => this.coerceNestedItem(field.items?.fields ?? [], item));
            }
            return value;
        }

        if (field.type === "string") {
            if (typeof value === "string") return value;
            return String(value);
        }

        if (field.type === "number") {
            if (typeof value === "number") return value;
            const coerced = coerceValue(value, "number");
            return coerced.coerced ? coerced.value : value;
        }

        if (field.type === "boolean") {
            if (typeof value === "boolean") return value;
            const coerced = coerceValue(value, "boolean");
            return coerced.coerced ? coerced.value : value;
        }

        return value;
    }

    private coerceNestedItem(
        fields: SchemaField[],
        item: Record<string, unknown>,
    ): Record<string, unknown> {
        const result: Record<string, unknown> = {};
        for (const field of fields) {
            const rawValue = item[field.name];
            if (rawValue === undefined || rawValue === null) continue;
            result[field.name] = this.coerceField(field, rawValue);
        }
        for (const key of Object.keys(item)) {
            if (!(key in result)) {
                result[key] = item[key];
            }
        }
        return result;
    }

    private postProcessWarnings(rawWarnings: LLMToolCallWarning[]): Warning[] {
        return rawWarnings.map((w) => ({
            type: "low_confidence",
            field: w.field,
            itemIndex: w.item_index,
            message: w.message,
        }));
    }

    private enrichMissingFields(
        rawMissing: LLMToolCallMissingField[],
        processedItems: Record<string, unknown>[],
    ): MissingField[] {
        const result: MissingField[] = rawMissing.map((m) => ({
            field: m.field,
            reason: m.reason,
            affectedItems: m.affected_items,
        }));

        const llmFields = rawMissing.map((m) => m.field);

        for (const field of this.schema.fields) {
            if (!field.required) continue;
            if (llmFields.includes(field.name)) continue;

            const missingCount = processedItems.filter(
                (item) =>
                    item[field.name] === undefined ||
                    item[field.name] === null ||
                    item[field.name] === "",
            ).length;

            if (missingCount > 0) {
                result.push({
                    field: field.name,
                    reason: "Required field missing in LLM extraction output",
                    affectedItems: missingCount,
                });
            }
        }

        return result;
    }
}

interface LLMToolCallMissingField {
    field: string;
    reason: string;
    affected_items: number;
}

interface LLMToolCallWarning {
    type: string;
    field: string;
    item_index: number;
    message: string;
}
