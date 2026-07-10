export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  // Manus's own proxy (the default forgeApiUrl) tolerates an omitted model
  // and picks one server-side; a real OpenAI-compatible endpoint requires
  // one explicitly. Only needed when forgeApiUrl is overridden.
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
};
