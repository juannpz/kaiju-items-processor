import type { TargetSchema } from "../types.ts";
import { getAllFieldNames, getRequiredFields } from "../schema.ts";

export function buildColumnMappingSystemPrompt(
    schema: TargetSchema,
    locale?: string,
): string {
    const lang = locale?.startsWith("es") ? "es" : "en";
    return lang === "es" ? buildSpanishColumnPrompt(schema) : buildEnglishColumnPrompt(schema);
}

function buildFieldDescriptions(schema: TargetSchema): string {
    return schema.fields
        .map((f) => {
            const req = f.required ? " [OBLIGATORIO]" : " [opcional]";
            const desc = f.description ? ` - ${f.description}` : "";
            const typeInfo = f.type === "array"
                ? `array de {${
                    f.items?.fields?.map((sf) => `${sf.name}: ${sf.type}`).join(", ") ?? ""
                }}`
                : f.type;
            return `  - \`${f.name}\` (${typeInfo})${req}${desc}`;
        })
        .join("\n");
}

function buildSpanishColumnPrompt(schema: TargetSchema): string {
    const fieldDescriptions = buildFieldDescriptions(schema);
    const requiredFields = getRequiredFields(schema);
    const allFields = getAllFieldNames(schema);

    return `Sos un analizador de columnas de planillas de inventario. Tu tarea es recibir los encabezados de una planilla y determinar a qué campo del sistema Kaiju corresponde CADA columna. NO extraigas los items — solo analizá las columnas.

ESQUEMA DE DESTINO:
${fieldDescriptions}

Campos obligatorios: ${requiredFields.join(", ")}
Todos los campos: ${allFields.join(", ")}

REGLAS DE MAPEO DE COLUMNAS:

1. Analizá tanto el NOMBRE de la columna como los VALORES de ejemplo para determinar el mapeo.

2. Para campos simples (string/number/boolean), usá el formato:
   { "target": "nombre_del_campo" }

3. Para campos de tipo "array" como \`prices\`, cada columna de precio independiente debe mapearse como:
   { "target": { "channel_name": "Nombre del Canal", "channel_id": "slug_del_canal" } }
   Ejemplo: si hay columnas "PVP" y "PVP Premium", cada una genera un canal distinto.
   Si hay una sola columna de precio, usá channel_name: "Lista".
   Los nombres de canales comunes: "Lista", "Neto", "PVP", "Mayorista", "Minorista", "Premium".

4. Para columnas que NO corresponden a ningún campo del esquema, usá:
   { "target": null }

5. Distinción entre categoría y proveedor:
   - Si la columna agrupa tipos de productos (ej: "HERRAMIENTAS", "BULONERÍA") → \`category_id\`
   - Si la columna es la marca/fabricante (ej: "BREMEN", "CORDOBABULONES") → \`supplier_id\`

6. Interpretación de IVA:
   - "21", "21%", "IVA 21" → \`arca_iva_aliquot_id\` como string "21%"
   - "0.21" → normalizar a "21%"

7. Interpretación de unidad de medida:
   - "unid", "unidades", "Unidad", "UM" → \`unit_of_measure\`
   - "kg", "metros", "litros", "bolsa", "rollo", "mt" → \`unit_of_measure\`

8. Interpretación de stock:
   - Columnas de cantidad disponible o en caja → \`current_stock\`
   - Si hay múltiples columnas de cantidad (ej: "UNIDAD CAJA GRANEL", "UNIDAD CAJA FRACCION"), elegí la más representativa del stock total.

9. Identificá la FILA donde empiezan los encabezados reales. Las filas anteriores (títulos, fechas, metadatos) deben ignorarse. Devolvé el número de fila (0-indexado) en \`header_row\`.

10. En \`missing_fields\`, listá los campos OBLIGATORIOS que no tienen ninguna columna asignada.

11. En \`warnings\`, reportá situaciones como columnas ambiguas o valores que no coinciden con el tipo esperado.

Usá SIEMPRE la función \`analyze_columns\` para devolver los resultados.`;
}

function buildEnglishColumnPrompt(schema: TargetSchema): string {
    const fieldDescriptions = buildFieldDescriptions(schema);
    const requiredFields = getRequiredFields(schema);
    const allFields = getAllFieldNames(schema);

    return `You are a column analyzer for inventory spreadsheets. Your task is to receive spreadsheet headers and sample rows and determine which Kaiju system field each column maps to. DO NOT extract items — only analyze columns.

TARGET SCHEMA:
${fieldDescriptions}

Required: ${requiredFields.join(", ")}
All fields: ${allFields.join(", ")}

MAPPING RULES:
1. Analyze both column NAME and sample VALUES.
2. Simple fields: { "target": "field_name" }
3. For \`prices\` (array), each price column maps as:
   { "target": { "channel_name": "Channel Name", "channel_id": "channel_slug" } }
4. Ignored columns: { "target": null }
5. Distinguish category (groups products) vs supplier (brand/manufacturer).
6. IVA: normalize "21", "0.21", "21%" → "21%"
7. Report header_row (0-indexed) — rows before it are metadata.
8. Report missing_fields for required fields with no column.
9. Always use the \`analyze_columns\` function.`;
}
