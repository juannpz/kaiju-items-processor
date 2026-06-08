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
            const desc = f.description ? ` — ${f.description}` : "";
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

    return `Sos un analizador de columnas de planillas de inventario del mercado argentino.
Tu tarea es recibir los encabezados de una planilla de proveedor y determinar a qué campo
del sistema Kaiju corresponde CADA columna. NO extraigas los items — solo devolvé el mapeo.

ESQUEMA DE DESTINO:
${fieldDescriptions}

Campos obligatorios: ${requiredFields.join(", ")}
Todos los campos disponibles: ${allFields.join(", ")}

REGLAS DE MAPEO:

1. Analizá tanto el NOMBRE de la columna como los VALORES de muestra.
   Ejemplos reales que aparecen en planillas de proveedores argentinos:
   - "COD", "Código", "SKU", "CODIGO INTERNO", "Codigo EAN", "CSP" → \`barcode\`
   - "PRODUCTO", "Item", "Descripción", "Descripción del Artículo", "Denominación" → \`name\`
   - "DESCRIPCION ADICIONAL", "Medida", "Variante" → \`suffix:name\` (se anexa al nombre, ej: "Bulón M6" + "x 20mm" → "Bulón M6 x 20mm")
   - "FAMILIA", "Grupo", "Categoría", "Rubro", "Categoria" → \`category_id\`
   - "MARCA", "Fabricante", "Proveedor" → \`supplier_id\`
   - "Unidad de Medida", "Unidad de Medida (UM)", "UM", "Unidad", "UM x Unidad" → \`unit_of_measure\`
   - "Stock", "Cantidad", "Existencia", "UNIDAD CAJA GRANEL", "Unidades" → \`current_stock\`
   - "IVA", "Alíc. IVA", "IVA %", "Neto+IVA/Un" → \`arca_iva_aliquot_id\`

2. Columnas con nombre genérico como "col_0", "col_6":
   El parser les puso ese nombre porque el encabezado original estaba vacío.
   Determiná su propósito SOLO mirando los valores de ejemplo.
   Si no tenés certeza, marcalas como ignoradas (target: null).

3. Formato de la respuesta:
   - Campo simple → { "target": "nombre_del_campo" }
   - Sufijo de otro campo (se anexa al valor principal) → { "target": "suffix:nombre_del_campo" }
   - Columna ignorada → { "target": null }
   - Columna de precio → { "target": { "channel_name": "Nombre", "channel_id": "slug" } }

4. CANALES DE PRECIO (clave):
   Cada columna de precio independiente genera un entry DISTINTO en \`prices\`.
   Ejemplo con 3 columnas: "PVP", "PVP Premium", "Precio de Lista"
     "PVP"           → { "target": { "channel_name": "PVP", "channel_id": "pvp" } }
     "PVP Premium"   → { "target": { "channel_name": "PVP Premium", "channel_id": "pvp_premium" } }
     "Precio de Lista" → { "target": { "channel_name": "Lista", "channel_id": "lista" } }
   Si hay UNA sola columna de precio, usá channel_name: "Lista".
   Nombres de canales comunes en Argentina: "Lista", "PVP", "Neto", "Venta", "Mayorista", "Premium", "Contado", "Oferta".
   IMPORTANTE: si ves la columna "Neto+IVA/Un" NO es un precio de canal — es info de IVA.
   Las columnas con "%" o "Bonif" o "Dto" o "Desc" NO son precios — son descuentos/bonificaciones.

5. CATEGORÍA vs MARCA:
   - Agrupa TIPOS de productos ("HERRAMIENTAS", "BULONERÍA", "Automotor", "INSUMOS", "JARDIN", "FERRETERIA") → \`category_id\`
   - Identifica el FABRICANTE ("BREMEN", "CORDOBABULONES", "TorniFast", "WEMBLEY", "TOLSEN") → \`supplier_id\`
   Si la planilla tiene ambas columnas (ej: "Categoría" + "Marca"), mapeá cada una a su campo.

6. IVA:
   - "21" → "21%"
   - "0.21" → "21%"
   - "21%", "IVA 21" → "21%"
   Siempre normalizá al formato "XX%".

7. STOCK:
   Si hay múltiples columnas de cantidad (ej: "UNIDAD CAJA GRANEL" y "UNIDAD CAJA FRACCION"),
   elegí la que mejor represente el stock total (generalmente la de valores más altos).
   IMPORTANTE: si TODAS las filas de muestra tienen valor 1 en una columna de cantidad,
   probablemente sea "cantidad por pack" o "unidades por caja", NO stock real.
   Marcá esas columnas como ignoradas y reportalo en warnings.

8. \`item_type_id\` es obligatorio en el esquema pero NUNCA aparece en planillas de proveedor.
   Es esperable que figure en missing_fields. No intentes inferirlo de otras columnas.

9. Identificá la FILA donde empiezan los encabezados reales (0-indexado).
   Las filas anteriores (títulos, fechas, logos, "Lista de Precios", filas con datos de descuento/bonificación, etc.) ignorarlas.
   No cuentan como filas de datos.

10. En \`missing_fields\`, listá solo los OBLIGATORIOS sin columna asignada.
    En \`warnings\`, reportá columnas ambiguas, columnas con valores que no calzan con el tipo esperado,
    y columnas de cantidad que parecen ser pack/caja en vez de stock real.

11. Las muestras vienen de DISTINTAS secciones del archivo (inicio, medio, final).
    Si ves que ciertas columnas solo tienen datos en algunas filas, no te preocupes —
    el mapeo se aplica a todas las filas. Columnas sin datos en una fila simplemente quedan vacías.

12. ANALIZÁ EL PORCENTAJE DE RELLENO de cada columna que se reporta al final.
    Columnas con muy bajo porcentaje (<5%) probablemente son ruido o datos excepcionales — considerá ignorarlas.

Usá SIEMPRE la función \`analyze_columns\` para devolver los resultados.`;
}

function buildEnglishColumnPrompt(schema: TargetSchema): string {
    const fieldDescriptions = buildFieldDescriptions(schema);
    const requiredFields = getRequiredFields(schema);
    const allFields = getAllFieldNames(schema);

    return `You are a column analyzer for inventory spreadsheets. Determine which Kaiju system field each column maps to. DO NOT extract items — only return the column mapping.

TARGET SCHEMA:
${fieldDescriptions}

Required fields: ${requiredFields.join(", ")}
All available: ${allFields.join(", ")}

MAPPING RULES:

1. Analyze both column names and sample values. Common column name patterns:
   - "COD", "SKU", "Code", "EAN", "Barcode" → \`barcode\`
   - "Product", "Item", "Description", "Name" → \`name\`
   - "Category", "Group", "Family", "Rubro" → \`category_id\`
   - "Brand", "Manufacturer", "Supplier" → \`supplier_id\`
   - "Stock", "Quantity", "Qty", "Available" → \`current_stock\`
   - "Unit", "UM", "UOM", "Measure" → \`unit_of_measure\`
   - "VAT", "Tax", "IVA" → \`arca_iva_aliquot_id\`

2. Columns with generic names like "col_0", "col_6" had empty headers originally.
   Analyze by VALUES only. If uncertain, mark as ignored (target: null).

3. Response format:
   - Simple field → { "target": "field_name" }
   - Suffix to another field → { "target": "suffix:field_name" }
   - Ignored column → { "target": null }
   - Price column → { "target": { "channel_name": "Name", "channel_id": "slug" } }

4. PRICE CHANNELS: Each independent price column creates a separate entry in \`prices\`.
   Example: "PVP", "MSRP", "Wholesale" → each gets its own channel entry.
   Single price column → channel_name: "List".

5. CATEGORY vs SUPPLIER:
   - Groups product types ("Tools", "Hardware") → \`category_id\`
   - Identifies the brand/manufacturer → \`supplier_id\`

6. IVA normalization: "21", "0.21", "21%" → "21%"

7. STOCK: if multiple quantity columns, choose the one representing TOTAL stock (higher values).

8. \`item_type_id\` is required but NEVER present in supplier lists. Expected in missing_fields.

9. Report \`header_row\` (0-indexed) where actual column headers start. Skip title/metadata rows above it.

10. In \`missing_fields\`, list only REQUIRED fields without a column. In \`warnings\`, report ambiguous columns.

Always use the \`analyze_columns\` function to return results.`;
}
