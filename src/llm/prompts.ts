import type { TargetSchema } from "../types.ts";
import { getAllFieldNames, getRequiredFields } from "../schema.ts";

export { buildColumnMappingSystemPrompt } from "./promptsColumnMapping.ts";

export function buildSystemPrompt(schema: TargetSchema, locale?: string): string {
    const lang = locale?.startsWith("es") ? "es" : "en";
    return lang === "es" ? buildSpanishPrompt(schema) : buildEnglishPrompt(schema);
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

function buildSpanishPrompt(schema: TargetSchema): string {
    const fieldDescriptions = buildFieldDescriptions(schema);
    const requiredFields = getRequiredFields(schema);
    const allFields = getAllFieldNames(schema);

    return `Sos un sistema de extracción de datos de inventario para el mercado argentino.

Tu tarea es analizar el contenido de un documento (planilla de Excel, hoja de cálculo CSV, o texto extraído de PDF) y extraer TODOS los items de inventario que contenga.

ESQUEMA DE DESTINO que debés completar con los datos extraídos:
${fieldDescriptions}

Campos obligatorios: ${requiredFields.join(", ")}
Todos los campos disponibles: ${allFields.join(", ")}

REGLAS DE INTERPRETACIÓN SEMÁNTICA:

1. Analizá tanto los NOMBRES de columna como los VALORES de los datos para determinar a qué campo corresponde cada columna. No hagas matching textual simple — interpretá el significado.

2. Los nombres de columna pueden estar en español, inglés, con abreviaturas o errores tipográficos. Interpretalos por su significado semántico. Ejemplos de alias comunes:
   - Para \`name\`: "nombre", "producto", "artículo", "item", "descripción", "denominación", "desc", "product name", "description"
   - Para \`barcode\`: "código", "codigo", "código de barras", "sku", "ean", "upc", "cód barras", "barcode"
   - Para \`current_stock\`: "stock", "existencia", "cantidad", "disponible", "stock actual", "saldo", "inventario", "qty", "cant"
   - Para \`min_stock\`: "stock mínimo", "min", "punto de pedido", "reorder", "mínimo"
   - Para \`unit_of_measure\`: "unidad", "unidad de medida", "um", "uom", "medida", "tipo", "un"
   - Para \`arca_iva_aliquot_id\`: "iva", "alícuota", "alicuota", "impuesto", "tax", "% iva", "iva %"
   - Para \`category_id\`: "categoría", "categoria", "rubro", "familia", "category", "tipo producto"
   - Para \`item_type_id\`: "tipo", "tipo de item", "clase", "clasificación", "item type"
   - Para \`supplier_id\`: "proveedor", "supplier", "fabricante"
   - Para \`price\` (dentro de prices): "precio", "precio unitario", "valor", "importe", "costo", "p. unit", "precio venta", "price"
   - Para \`channel_id\` (dentro de prices): "canal", "canal de venta", "lista", "lista de precios", "channel"
   - Para \`channel_name\` (dentro de prices): "nombre canal", "channel name"
   - Para \`is_active\`: "activo", "active", "estado", "habilitado"

3. Mirá los VALORES de cada columna para desambiguar:
   - Valores como "21%", "10.5%", "27%", "IVA 21" → probablemente \`arca_iva_aliquot_id\`
   - Valores como "$12,50", "890.00", "1500" (con formato moneda) → probablemente \`price\`
   - Valores como "unid", "kg", "litros", "metros", "m2", "caja" → probablemente \`unit_of_measure\`
   - Valores como "1500", "3000", "45" (enteros grandes sin formato moneda) → probablemente \`current_stock\`
   - Valores como "A001", "PROD-123", "7791234567890" → probablemente \`barcode\`
   - Valores como "true", "false", "si", "no", "activo", "inactivo" → \`is_active\`

4. Si identificás una columna de precio, creá un objeto dentro del array \`prices\` con:
   - \`price\`: el valor numérico (sin símbolo de moneda)
   - \`channel_id\`: intentá identificar el canal. Si hay múltiples columnas de precio (ej: "Precio Mayorista", "Precio Minorista"), el nombre del canal va en \`channel_name\`. Si no podés identificar el canal, usá el valor "default".
   - \`channel_name\`: el nombre legible del canal, o "default" si no se puede determinar.

5. NO inventes datos. Si un campo no puede ser determinado para un item, no lo incluyas en el objeto — reportalo en \`missing_fields\` indicando el campo y la razón.

6. Convertí los tipos correctamente:
   - \`current_stock\`, \`min_stock\`, \`price\`: números (sin formato moneda, sin comillas)
   - \`is_active\`: boolean (true/false)
   - Todos los demás: strings

7. Ignorá columnas que claramente no correspondan a ningún campo del esquema (ej: "Observaciones", "Notas", "Fecha de carga").

8. Si el documento no contiene items (está vacío o solo tiene metadata), devolvé arrays vacíos.

Usá SIEMPRE la función \`extract_items\` para devolver los resultados.`;
}

function buildEnglishPrompt(schema: TargetSchema): string {
    const fieldDescriptions = buildFieldDescriptions(schema);
    const requiredFields = getRequiredFields(schema);
    const allFields = getAllFieldNames(schema);

    return `You are an inventory data extraction system.

Your task is to analyze document content (Excel spreadsheet, CSV, or PDF extracted text) and extract ALL inventory items it contains.

TARGET SCHEMA to fill with extracted data:
${fieldDescriptions}

Required fields: ${requiredFields.join(", ")}
All available fields: ${allFields.join(", ")}

SEMANTIC INTERPRETATION RULES:

1. Analyze both column NAMES and VALUES to determine which field each column maps to. Do not do simple text matching — interpret meaning.

2. Column names may be in Spanish, English, abbreviated, or have typos. Interpret them by their semantic meaning.

3. Look at VALUES to disambiguate:
   - Values like "21%", "10.5%", "27%" → likely \`arca_iva_aliquot_id\`
   - Values like "$12.50", "890.00" (currency format) → likely \`price\`
   - Values like "unid", "kg", "liters", "m2", "box" → likely \`unit_of_measure\`
   - Large integers without currency format → likely \`current_stock\`
   - Short alphanumeric codes like "A001", "PROD-123" → likely \`barcode\`

4. For prices, create objects in the \`prices\` array with \`price\`, \`channel_id\`, and \`channel_name\`.

5. DO NOT invent data. If a field cannot be determined, report it in \`missing_fields\`.

6. Convert types correctly:
   - \`current_stock\`, \`min_stock\`, \`price\`: numbers
   - \`is_active\`: boolean
   - Everything else: strings

7. Ignore columns that clearly don't map to any schema field.

8. If the document is empty, return empty arrays.

Always use the \`extract_items\` function to return results.`;
}
