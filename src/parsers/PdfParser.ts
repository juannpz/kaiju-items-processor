import type { Parser, RawContent } from "./types.ts";

export class PdfParser implements Parser {
    readonly format = "pdf";

    canParse(_data: Uint8Array, filename?: string): boolean {
        if (filename) {
            const ext = filename.split(".").pop()?.toLowerCase();
            return ext === "pdf";
        }
        return false;
    }

    parse(data: Uint8Array): RawContent {
        const header = new TextDecoder().decode(data.slice(0, 5));

        if (header === "%PDF-") {
            throw new PdfParseError(
                "PDF parsing requires an external OCR service. " +
                    "For digital PDFs, configure a text extraction service. " +
                    "For scanned PDFs, configure an OCR endpoint (e.g. Tesseract, Google Cloud Vision, AWS Textract). " +
                    "Set the 'ocr' option in ProcessorConfig to enable PDF support.",
            );
        }

        throw new PdfParseError("File does not appear to be a valid PDF");
    }
}

export class PdfParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PdfParseError";
    }
}
