export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  // Manus's own built-in proxy — used only by unrelated platform features
  // (the file storage proxy). Not part of the AI claim-extraction pipeline.
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",

  // AI provider for claim extraction (server/_core/llm.ts). Swap providers
  // by changing AI_PROVIDER alone — no code changes needed elsewhere.
  // "openai" (GPT-4 Vision via Chat Completions, default), "anthropic"
  // (native Claude Messages API), or "openrouter" (OpenAI-compatible proxy
  // that can reach Claude, Gemini, etc.).
  aiProvider: (process.env.AI_PROVIDER ?? "openai").trim().toLowerCase(),
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  openrouterModel: process.env.OPENROUTER_MODEL ?? "anthropic/claude-3.5-sonnet",

  get aiModel(): string {
    if (ENV.aiProvider === "openrouter") return ENV.openrouterModel;
    if (ENV.aiProvider === "anthropic") return ENV.anthropicModel;
    return ENV.openaiModel;
  },
};
