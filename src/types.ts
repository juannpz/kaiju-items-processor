export type SchemaPrimitiveType = "string" | "number" | "boolean";

export type SchemaFieldType = SchemaPrimitiveType | "array";

export interface SchemaField {
    name: string;
    type: SchemaFieldType;
    required: boolean;
    description?: string;
    items?: {
        fields: SchemaField[];
    };
}

export interface TargetSchema {
    fields: SchemaField[];
    description?: string;
}

export type DocumentInput = Uint8Array | string;

export type DocumentFormat = "excel" | "csv" | "pdf";

export interface ProcessInput {
    document: DocumentInput;
    format?: DocumentFormat | "auto";
    filename?: string;
}

export interface LLMConfig {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    maxTokens?: number;
    temperature?: number;
    stream?: boolean;
}

export interface ProcessorConfig {
    schema: TargetSchema;
    llm: LLMConfig;
    locale?: string;
}

export interface MissingField {
    field: string;
    reason: string;
    affectedItems: number;
}

export type WarningType =
    | "type_coercion"
    | "low_confidence"
    | "missing_value"
    | "unknown_format";

export interface Warning {
    type: WarningType;
    field: string;
    itemIndex: number;
    message: string;
    originalValue?: string;
}

export interface ProcessMeta {
    sourceType: string;
    totalRowsFound: number;
    itemsExtracted: number;
    llmTokensUsed?: number;
    processingTimeMs: number;
}

export interface ProcessResult<T = Record<string, unknown>> {
    items: T[];
    missingFields: MissingField[];
    warnings: Warning[];
    meta: ProcessMeta;
}
