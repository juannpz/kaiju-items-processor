export interface TabularData {
    headers: string[];
    rows: Record<string, unknown>[];
    totalRows: number;
    sheetName?: string;
}

export interface RawContent {
    type: "tabular" | "text";
    data: TabularData | string;
}

export interface Parser {
    readonly format: string;
    parse(data: Uint8Array, options?: ParserOptions): Promise<RawContent> | RawContent;
    canParse(data: Uint8Array, filename?: string): boolean;
}

export interface ParserOptions {
    sheetIndex?: number;
    headerRow?: number;
    delimiter?: string;
}
