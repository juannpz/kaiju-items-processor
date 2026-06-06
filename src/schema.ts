import type { SchemaField, SchemaPrimitiveType, TargetSchema } from "./types.ts";

export { type SchemaField, type SchemaFieldType, type TargetSchema } from "./types.ts";

export function defineSchema(config: {
    fields: SchemaField[];
    description?: string;
}): TargetSchema {
    return {
        fields: config.fields,
        description: config.description,
    };
}

function mapPrimitiveType(type: SchemaPrimitiveType): Record<string, string> {
    const typeMap: Record<SchemaPrimitiveType, string> = {
        string: "string",
        number: "number",
        boolean: "boolean",
    };
    return { type: typeMap[type] };
}

function buildFieldJsonSchema(field: SchemaField): Record<string, unknown> {
    if (field.type === "array") {
        const nestedFields = field.items?.fields ?? [];
        const nestedProperties: Record<string, unknown> = {};
        const nestedRequired: string[] = [];

        for (const nf of nestedFields) {
            nestedProperties[nf.name] = nf.type === "array"
                ? buildFieldJsonSchema(nf)
                : mapPrimitiveType(nf.type);
            if (nf.required) {
                nestedRequired.push(nf.name);
            }
        }

        return {
            type: "array",
            items: {
                type: "object",
                properties: nestedProperties,
                ...(nestedRequired.length > 0 ? { required: nestedRequired } : {}),
                additionalProperties: false,
            },
        };
    }

    return mapPrimitiveType(field.type);
}

function buildTopLevelJsonSchema(schema: TargetSchema): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const field of schema.fields) {
        properties[field.name] = buildFieldJsonSchema(field);
        if (field.required) {
            required.push(field.name);
        }
    }

    return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
    };
}

export function buildToolParameters(schema: TargetSchema): Record<string, unknown> {
    const itemSchema = buildTopLevelJsonSchema(schema);

    return {
        type: "object",
        properties: {
            items: {
                type: "array",
                items: itemSchema,
            },
            missing_fields: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        field: { type: "string" },
                        reason: { type: "string" },
                        affected_items: { type: "integer" },
                    },
                    required: ["field", "reason", "affected_items"],
                    additionalProperties: false,
                },
            },
            warnings: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        type: { type: "string" },
                        field: { type: "string" },
                        item_index: { type: "integer" },
                        message: { type: "string" },
                    },
                    required: ["type", "field", "item_index", "message"],
                    additionalProperties: false,
                },
            },
        },
        required: ["items", "missing_fields", "warnings"],
        additionalProperties: false,
    };
}

export function buildColumnMappingToolParameters(): Record<string, unknown> {
    return {
        type: "object",
        properties: {
            column_mapping: {
                type: "object",
                description:
                    "Mapeo de nombre de columna a su target. La key es el nombre exacto de la columna. El value es { target: field_name } para campos simples, { target: { channel_name, channel_id } } para canales de precio, o { target: null } para columnas ignoradas.",
                additionalProperties: {
                    type: "object",
                    properties: {
                        target: {
                            description:
                                "Nombre del campo destino, objeto de canal de precio, o null",
                        },
                    },
                    required: ["target"],
                },
            },
            header_row: {
                type: "integer",
                description: "Índice (0-indexado) de la fila donde empiezan los encabezados reales",
            },
            missing_fields: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        field: { type: "string" },
                        reason: { type: "string" },
                    },
                    required: ["field", "reason"],
                    additionalProperties: false,
                },
            },
            warnings: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        field: { type: "string" },
                        message: { type: "string" },
                    },
                    required: ["field", "message"],
                    additionalProperties: false,
                },
            },
        },
        required: ["column_mapping", "header_row", "missing_fields", "warnings"],
        additionalProperties: false,
    };
}

export function getRequiredFields(schema: TargetSchema): string[] {
    return schema.fields
        .filter((f) => f.required)
        .map((f) => f.name);
}

export function getAllFieldNames(schema: TargetSchema): string[] {
    return schema.fields.map((f) => f.name);
}
