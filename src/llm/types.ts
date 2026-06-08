export interface LLMToolCallResponse {
    items: Record<string, unknown>[];
    missing_fields: {
        field: string;
        reason: string;
        affected_items: number;
    }[];
    warnings: {
        type: string;
        field: string;
        item_index: number;
        message: string;
    }[];
}

export interface LLMRequestConfig {
    model: string;
    baseUrl: string;
    apiKey: string;
    maxTokens: number;
    temperature: number;
    stream: boolean;
}

export const DEFAULT_LLM_CONFIG: Partial<LLMRequestConfig> = {
    model: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com",
    maxTokens: 32000,
    temperature: 0.1,
    stream: true,
};
