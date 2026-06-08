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
import { buildColumnMappingSystemPrompt, buildSystemPrompt } from "./llm/prompts.ts";
import { buildColumnMappingToolParameters, buildToolParameters } from "./schema.ts";
import { LLMClient, LLMError } from "./llm/LLMClient.ts";
import { formatForLLM } from "./utils/contentFormatter.ts";
import type { ColumnMapping, ColumnTarget, LLMColumnMappingResponse } from "./mapping/types.ts";
import { applyColumnMapping } from "./mapping/applyMapping.ts";
import { coerceValue } from "./utils/typeCoercion.ts";

const DEFAULT_LLM_TIMEOUT_MS = 300_000;

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

        if (rawContent.type === "tabular") {
            const data = rawContent.data;

            if (Array.isArray(data)) {
                return this.processMultiSheet<T>(data, resolvedFormat, startTime, input.sheets);
            }

            return this.processSingleSheet<T>(data as TabularData, resolvedFormat, startTime);
        }

        return this.processText<T>(rawContent, resolvedFormat, startTime);
    }

    private async processMultiSheet<T extends Record<string, unknown>>(
        sheets: TabularData[],
        sourceType: string,
        startTime: number,
        sheetFilter?: string[],
    ): Promise<ProcessResult<T>> {
        const filtered = sheetFilter && sheetFilter.length > 0
            ? sheets.filter((s) => sheetFilter.includes(s.sheetName ?? ""))
            : sheets;
        const allItems: Record<string, unknown>[] = [];
        const allWarnings: Warning[] = [];
        const allMissingFields: Array<{ field: string; reason: string; affectedItems: number }> =
            [];
        let totalRowsFound = 0;
        let totalTokensUsed = 0;

        for (const sheet of filtered) {
            const sheetResult = await this.processSingleSheetRaw(
                sheet,
            );

            for (const item of sheetResult.items) {
                item["_sheet"] = sheet.sheetName ?? "";
            }

            allItems.push(...sheetResult.items);
            allWarnings.push(...sheetResult.warnings);
            totalRowsFound += sheetResult.totalRowsFound;
            totalTokensUsed += sheetResult.tokensUsed;

            for (const mf of sheetResult.missingFields) {
                allMissingFields.push(mf);
            }
        }

        const mergedMissingFields = this.mergeMissingFields(allMissingFields, allItems.length);

        const meta: ProcessMeta = {
            sourceType,
            totalRowsFound,
            itemsExtracted: allItems.length,
            llmTokensUsed: totalTokensUsed,
            processingTimeMs: Date.now() - startTime,
        };

        return {
            items: allItems as T[],
            missingFields: mergedMissingFields,
            warnings: allWarnings,
            meta,
        };
    }

    private async processSingleSheet<T extends Record<string, unknown>>(
        data: TabularData,
        sourceType: string,
        startTime: number,
    ): Promise<ProcessResult<T>> {
        const raw = await this.processSingleSheetRaw(data);

        const meta: ProcessMeta = {
            sourceType,
            totalRowsFound: raw.totalRowsFound,
            itemsExtracted: raw.items.length,
            llmTokensUsed: raw.tokensUsed,
            processingTimeMs: Date.now() - startTime,
        };

        return {
            items: raw.items as T[],
            missingFields: raw.missingFields,
            warnings: raw.warnings,
            meta,
        };
    }

    private async processSingleSheetRaw(
        data: TabularData,
    ): Promise<{
        items: Record<string, unknown>[];
        missingFields: Array<{ field: string; reason: string; affectedItems: number }>;
        warnings: Warning[];
        totalRowsFound: number;
        tokensUsed: number;
    }> {
        if (data.totalRows === 0) {
            return {
                items: [],
                missingFields: [],
                warnings: [],
                totalRowsFound: 0,
                tokensUsed: 0,
            };
        }

        const formattedContent = formatForLLM({ type: "tabular", data });
        if (formattedContent === "El documento no contiene datos.") {
            return {
                items: [],
                missingFields: [],
                warnings: [],
                totalRowsFound: 0,
                tokensUsed: 0,
            };
        }

        const systemPrompt = buildColumnMappingSystemPrompt(this.schema, this.locale);
        const toolParameters = buildColumnMappingToolParameters();

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        let llmResult: LLMColumnMappingResponse;
        let tokensUsed = 0;

        try {
            const response = await this.llmClient.analyzeColumns(
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

        const columnMapping = this.buildColumnMapping(llmResult.column_mapping);

        const extractResult = applyColumnMapping(data, columnMapping, this.schema);

        const warnings = this.buildWarnings(llmResult, extractResult);

        return {
            items: extractResult.items,
            missingFields: extractResult.missingFields,
            warnings,
            totalRowsFound: data.totalRows,
            tokensUsed,
        };
    }

    private mergeMissingFields(
        missingFields: Array<{ field: string; reason: string; affectedItems: number }>,
        totalItems: number,
    ): Array<{ field: string; reason: string; affectedItems: number }> {
        const merged = new Map<string, number>();

        for (const mf of missingFields) {
            const current = merged.get(mf.field) ?? 0;
            merged.set(mf.field, current + mf.affectedItems);
        }

        return [...merged.entries()].map(([field, count]) => ({
            field,
            reason: `Missing from source data (${count} of ${totalItems} items)`,
            affectedItems: count,
        }));
    }

    private async processText<T extends Record<string, unknown>>(
        rawContent: RawContent,
        sourceType: string,
        startTime: number,
    ): Promise<ProcessResult<T>> {
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
            totalRowsFound: 0,
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

    private buildColumnMapping(
        llmMapping: LLMColumnMappingResponse["column_mapping"],
    ): ColumnMapping {
        const columns: Record<string, ColumnTarget> = {};

        for (const [colName, colDef] of Object.entries(llmMapping)) {
            if (colDef.target === null || colDef.target === undefined) {
                columns[colName] = { type: "ignore" };
                continue;
            }

            if (typeof colDef.target === "string") {
                if (colDef.target.startsWith("suffix:")) {
                    const parentField = colDef.target.replace("suffix:", "");
                    columns[colName] = { type: "field_suffix", field: parentField };
                } else {
                    columns[colName] = { type: "field", field: colDef.target };
                }
                continue;
            }

            if (typeof colDef.target === "object" && "channel_name" in colDef.target) {
                columns[colName] = {
                    type: "price_channel",
                    channel_name: colDef.target.channel_name,
                    channel_id: colDef.target.channel_id ?? undefined,
                };
                continue;
            }

            columns[colName] = { type: "ignore" };
        }

        return {
            columns,
            header_row: 0,
        };
    }

    private buildWarnings(
        llmResult: LLMColumnMappingResponse,
        extractResult: { warnings: Array<Warning> },
    ): Warning[] {
        const warnings: Warning[] = [];

        for (const w of llmResult.warnings ?? []) {
            warnings.push({
                type: "low_confidence",
                field: w.field,
                itemIndex: -1,
                message: w.message,
            });
        }

        warnings.push(...extractResult.warnings);

        return warnings;
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

    private coerceField(field: import("./types.ts").SchemaField, value: unknown): unknown {
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
        fields: import("./types.ts").SchemaField[],
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
