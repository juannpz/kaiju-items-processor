export { DocumentProcessor } from "./DocumentProcessor.ts";
export { defineSchema } from "./schema.ts";
export { LLMError } from "./llm/LLMClient.ts";
export { ParseError } from "./parsers/ExcelParser.ts";
export { PdfParseError } from "./parsers/PdfParser.ts";
export { FormatDetectionError } from "./parsers/index.ts";
export { ColumnMappingCache, PromptOptimizer, TrainingLogger } from "./training/index.ts";

export type { TrainingLogEntry } from "./training/TrainingLogger.ts";

export type {
    ApplyMappingResult,
    ColumnMapping,
    ColumnTarget,
    LLMColumnMappingResponse,
} from "./mapping/types.ts";

export type {
    DocumentFormat,
    DocumentInput,
    LLMConfig,
    MissingField,
    ProcessInput,
    ProcessMeta,
    ProcessorConfig,
    ProcessResult,
    SchemaField,
    SchemaFieldType,
    TargetSchema,
    Warning,
    WarningType,
} from "./types.ts";
