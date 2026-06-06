# @juannpz/kaiju-items-processor

Document import and semantic extraction library for Deno. Parses Excel, CSV, and PDF documents and
uses LLM-powered semantic understanding to extract structured data matching a target schema —
regardless of how the source document names or organizes its columns.

## Features

- **Multi-format parsing**: Excel (.xlsx, .xls), CSV, TSV, and PDF text extraction
- **Semantic column mapping**: DeepSeek v4 Pro interprets column meaning from headers AND values,
  not just text matching
- **Structured extraction**: Returns data in your exact target schema via strict tool calling
- **Missing field tracking**: Reports which required fields couldn't be extracted and why
- **Type coercion safety net**: Post-processes LLM output to ensure correct types
- **Deno-first**: Published on JSR, zero Node.js-specific dependencies

## Installation

```json
// deno.json
{
    "imports": {
        "@juannpz/kaiju-items-processor": "jsr:@juannpz/kaiju-items-processor@0.1.0"
    }
}
```

## Quick Start

```typescript
import { defineSchema, DocumentProcessor } from "@juannpz/kaiju-items-processor";

// 1. Define your target schema
const itemSchema = defineSchema({
    fields: [
        { name: "name", type: "string", required: true, description: "Item name" },
        { name: "barcode", type: "string", required: false, description: "Barcode/SKU" },
        { name: "current_stock", type: "number", required: false, description: "Current stock" },
        { name: "unit_of_measure", type: "string", required: true, description: "Unit of measure" },
        { name: "arca_iva_aliquot_id", type: "string", required: true, description: "IVA aliquot" },
        {
            name: "prices",
            type: "array",
            required: false,
            items: {
                fields: [
                    { name: "price", type: "number", required: true },
                    { name: "channel_id", type: "string", required: true },
                    { name: "channel_name", type: "string", required: false },
                ],
            },
        },
    ],
    description: "Kaiju inventory item schema",
});

// 2. Create the processor with LLM configuration
const processor = new DocumentProcessor({
    schema: itemSchema,
    llm: {
        apiKey: Deno.env.get("DEEPSEEK_API_KEY")!,
        model: "deepseek-v4-pro",
    },
    locale: "es",
});

// 3. Process a document (accepts Uint8Array or base64 string)
const result = await processor.process({
    document: base64EncodedFile, // from HTTP request body
    format: "auto", // or "excel", "csv", "pdf"
    filename: "inventario.xlsx", // helps with format detection
});

// 4. Inspect the result
console.log(result.items); // FullItem[]
console.log(result.missingFields); // [{ field: "unit_of_measure", reason: "...", affectedItems: 3 }]
console.log(result.warnings); // [{ type: "low_confidence", field: "barcode", ... }]
console.log(result.meta); // { sourceType: "excel", totalRowsFound: 150, itemsExtracted: 148, ... }
```

## How It Works

```
CLIENT (base64 file)
    │
    ▼
┌──────────────────────────────┐
│ 1. PARSE (SheetJS / pdf-parse) │   Extract raw tabular data or text
├──────────────────────────────┤
│ 2. FORMAT                     │   Convert to LLM-friendly text representation
├──────────────────────────────┤
│ 3. LLM EXTRACTION (DeepSeek)  │   Semantic interpretation via strict tool calling:
│                                │   • Analyzes headers AND values
│                                │   • Understands Spanish/English aliases
│                                │   • Disambiguates by data patterns
│                                │   • Returns structured JSON matching schema
├──────────────────────────────┤
│ 4. POST-PROCESS               │   Type coercion + missing field enrichment
└──────────────────────────────┘
    │
    ▼
{ items: FullItem[], missingFields: [...], warnings: [...], meta }
```

## API Reference

### `defineSchema(config)`

Creates a `TargetSchema` definition used for both LLM tool calling and post-processing.

```typescript
defineSchema({
    fields: SchemaField[],
    description?: string,
}): TargetSchema
```

### `DocumentProcessor`

```typescript
class DocumentProcessor {
    constructor(config: ProcessorConfig);
    process<T>(input: ProcessInput): Promise<ProcessResult<T>>;
}
```

### Types

| Type               | Description                                                                        |
| ------------------ | ---------------------------------------------------------------------------------- |
| `ProcessInput`     | `{ document: Uint8Array                                                            |
| `ProcessResult<T>` | `{ items: T[], missingFields, warnings, meta }`                                    |
| `MissingField`     | `{ field: string, reason: string, affectedItems: number }`                         |
| `Warning`          | `{ type, field, itemIndex, message, originalValue? }`                              |
| `ProcessMeta`      | `{ sourceType, totalRowsFound, itemsExtracted, llmTokensUsed?, processingTimeMs }` |

### Errors

| Error                  | When                                                     |
| ---------------------- | -------------------------------------------------------- |
| `LLMError`             | DeepSeek API failure, timeout, or response parsing error |
| `ParseError`           | Excel/CSV parsing failure                                |
| `PdfParseError`        | PDF file detected but PDF parsing is not configured      |
| `FormatDetectionError` | Cannot determine document format from data/filename      |
