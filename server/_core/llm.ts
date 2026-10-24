import { ENV } from "./env";

export type Role = "system" | "user" | "assistant" | "tool" | "function";

export type TextContent = {
  type: "text";
  text: string;
};

export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type FileContent = {
  type: "file_url";
  file_url: {
    url: string;
    mime_type?: "audio/mpeg" | "audio/wav" | "application/pdf" | "audio/mp4" | "video/mp4" ;
  };
};

/** Native PDF file input (base64 data URI) — lets a vision-capable model read
 *  a PDF directly, with no local text extraction needed. Provider-agnostic:
 *  each provider adapter below translates it into that vendor's own document/
 *  file content-block shape. */
export type PdfFileContent = {
  type: "file";
  file: {
    filename: string;
    file_data: string; // "data:application/pdf;base64,<...>"
  };
};

export type MessageContent = string | TextContent | ImageContent | FileContent | PdfFileContent;

export type Message = {
  role: Role;
  content: MessageContent | MessageContent[];
  name?: string;
  tool_call_id?: string;
};

export type Tool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type ToolChoicePrimitive = "none" | "auto" | "required";
export type ToolChoiceByName = { name: string };
export type ToolChoiceExplicit = {
  type: "function";
  function: {
    name: string;
  };
};

export type ToolChoice =
  | ToolChoicePrimitive
  | ToolChoiceByName
  | ToolChoiceExplicit;

export type InvokeParams = {
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  model?: string;
  thinking?: Record<string, unknown>;
  reasoning?: Record<string, unknown>;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: Role;
      content: string | Array<TextContent | ImageContent | FileContent>;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type OutputSchema = JsonSchema;

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchema };

const ensureArray = (
  value: MessageContent | MessageContent[]
): MessageContent[] => (Array.isArray(value) ? value : [value]);

const normalizeContentPart = (
  part: MessageContent
): TextContent | ImageContent | FileContent | PdfFileContent => {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }

  if (part.type === "text") {
    return part;
  }

  if (part.type === "image_url") {
    return part;
  }

  if (part.type === "file_url") {
    return part;
  }

  if (part.type === "file") {
    return part;
  }

  throw new Error("Unsupported message content part");
};

const normalizeMessage = (message: Message) => {
  const { role, name, tool_call_id } = message;

  if (role === "tool" || role === "function") {
    const content = ensureArray(message.content)
      .map(part => (typeof part === "string" ? part : JSON.stringify(part)))
      .join("\n");

    return {
      role,
      name,
      tool_call_id,
      content,
    };
  }

  const contentParts = ensureArray(message.content).map(normalizeContentPart);

  // If there's only text content, collapse to a single string for compatibility
  if (contentParts.length === 1 && contentParts[0].type === "text") {
    return {
      role,
      name,
      content: contentParts[0].text,
    };
  }

  return {
    role,
    name,
    content: contentParts,
  };
};

const normalizeToolChoice = (
  toolChoice: ToolChoice | undefined,
  tools: Tool[] | undefined
): "none" | "auto" | ToolChoiceExplicit | undefined => {
  if (!toolChoice) return undefined;

  if (toolChoice === "none" || toolChoice === "auto") {
    return toolChoice;
  }

  if (toolChoice === "required") {
    if (!tools || tools.length === 0) {
      throw new Error(
        "tool_choice 'required' was provided but no tools were configured"
      );
    }

    if (tools.length > 1) {
      throw new Error(
        "tool_choice 'required' needs a single tool or specify the tool name explicitly"
      );
    }

    return {
      type: "function",
      function: { name: tools[0].function.name },
    };
  }

  if ("name" in toolChoice) {
    return {
      type: "function",
      function: { name: toolChoice.name },
    };
  }

  return toolChoice;
};

const normalizeResponseFormat = ({
  responseFormat,
  response_format,
  outputSchema,
  output_schema,
}: {
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
}):
  | { type: "json_schema"; json_schema: JsonSchema }
  | { type: "text" }
  | { type: "json_object" }
  | undefined => {
  const explicitFormat = responseFormat || response_format;
  if (explicitFormat) {
    if (
      explicitFormat.type === "json_schema" &&
      !explicitFormat.json_schema?.schema
    ) {
      throw new Error(
        "responseFormat json_schema requires a defined schema object"
      );
    }
    return explicitFormat;
  }

  const schema = outputSchema || output_schema;
  if (!schema) return undefined;

  if (!schema.name || !schema.schema) {
    throw new Error("outputSchema requires both name and schema");
  }

  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.schema,
      ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
    },
  };
};

const RETRY_MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 30_000;

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

const parseRetryAfter = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
};

// Equal-jitter exponential backoff. The cap/2 floor guarantees a minimum
// delay so a misbehaving caller loop slows down instead of hammering the
// upstream while it keeps returning errors.
const computeBackoffDelay = (
  attempt: number,
  retryAfterMs?: number
): number => {
  const cap = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  const jittered = cap / 2 + Math.random() * (cap / 2);
  return Math.min(Math.max(jittered, retryAfterMs ?? 0), RETRY_MAX_DELAY_MS);
};

// Retries non-2xx responses and network errors with exponential backoff, then
// returns the final Response so callers keep their existing error handling.
// Provider-agnostic: every adapter below (OpenAI, Anthropic, OpenRouter)
// routes its HTTP call through this so rate-limit/timeout/network handling
// stays identical no matter which vendor is active.
const fetchWithBackoff = async (
  url: string,
  init: FetchInit
): Promise<Response> => {
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok || attempt === RETRY_MAX_RETRIES) {
        return response;
      }

      const retryAfterMs = parseRetryAfter(
        response.headers.get("retry-after")
      );
      try {
        await response.body?.cancel();
      } catch {
        // Body already settled; nothing to clean up.
      }
      console.warn(
        `[LLM:${ENV.aiProvider}] retry ${attempt + 1}/${RETRY_MAX_RETRIES} after status ${response.status}`
      );
      await sleep(computeBackoffDelay(attempt, retryAfterMs));
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_MAX_RETRIES) throw error;
      console.warn(
        `[LLM:${ENV.aiProvider}] retry ${attempt + 1}/${RETRY_MAX_RETRIES} after network error`
      );
      await sleep(computeBackoffDelay(attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("LLM request failed after exhausting retries");
};

// A generous but finite timeout so a hung upstream call can never wedge the
// upload request forever — the route handler's catch block turns this into a
// controlled error response instead of a crash.
const REQUEST_TIMEOUT_MS = 90_000;

const fetchWithTimeout = async (
  url: string,
  init: FetchInit
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchWithBackoff(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`LLM request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// OpenAI adapter — primary provider. Native Chat Completions API. This is
// the OpenAI-compatible wire format everything else in this file is already
// normalized against (see normalizeMessage/normalizeToolChoice/
// normalizeResponseFormat above), so the request body is built directly from
// those shared helpers — no vendor-specific translation needed, unlike the
// Anthropic adapter below.
// ---------------------------------------------------------------------------

const resolveOpenAIUrl = () => "https://api.openai.com/v1/chat/completions";

async function invokeOpenAI(params: InvokeParams): Promise<InvokeResult> {
  if (!ENV.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const {
    messages,
    tools,
    toolChoice,
    tool_choice,
    outputSchema,
    output_schema,
    responseFormat,
    response_format,
    model,
    maxTokens,
    max_tokens,
  } = params;

  const payload: Record<string, unknown> = {
    model: model || ENV.openaiModel,
    messages: messages.map(normalizeMessage),
  };

  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  const normalizedToolChoice = normalizeToolChoice(toolChoice || tool_choice, tools);
  if (normalizedToolChoice) {
    payload.tool_choice = normalizedToolChoice;
  }

  const resolvedMaxTokens = max_tokens ?? maxTokens;
  if (typeof resolvedMaxTokens === "number") {
    payload.max_tokens = resolvedMaxTokens;
  }

  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema,
  });
  if (normalizedResponseFormat) {
    payload.response_format = normalizedResponseFormat;
  }

  const response = await fetchWithTimeout(resolveOpenAIUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ENV.openaiApiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM invoke failed: ${response.status} ${response.statusText} – ${errorText}`);
  }

  return (await response.json()) as InvokeResult;
}

// ---------------------------------------------------------------------------
// Anthropic (Claude) adapter — secondary/swap provider. Native Messages API,
// not OpenAI-compatible, so it gets its own request/response translation.
// This is the only place that knows Anthropic's wire format; everything
// above and everything calling invokeLLM() only ever sees the
// InvokeParams/InvokeResult shapes already used throughout the app.
// ---------------------------------------------------------------------------

const ANTHROPIC_API_VERSION = "2023-06-01";
const ANTHROPIC_PDF_BETA = "pdfs-2024-09-25";
const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;
const ANTHROPIC_TOOL_NAME = "emit_structured_output";

const resolveAnthropicUrl = () => "https://api.anthropic.com/v1/messages";

const dataUriToBase64 = (dataUri: string): string => {
  const commaIdx = dataUri.indexOf(",");
  return commaIdx === -1 ? dataUri : dataUri.slice(commaIdx + 1);
};

const toAnthropicContentBlock = (
  part: TextContent | ImageContent | FileContent | PdfFileContent
): Record<string, unknown> => {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  if (part.type === "image_url") {
    // Inline images (data:image/png;base64,...) — e.g. a rendered scanned
    // CMS-1500 page — must go as a base64 source; Anthropic's url source
    // only accepts http(s) URLs.
    const inline = part.image_url.url.match(/^data:(image\/[a-z+.-]+);base64,/i);
    if (inline) {
      return { type: "image", source: { type: "base64", media_type: inline[1].toLowerCase(), data: dataUriToBase64(part.image_url.url) } };
    }
    return { type: "image", source: { type: "url", url: part.image_url.url } };
  }
  if (part.type === "file") {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: dataUriToBase64(part.file.file_data),
      },
      title: part.file.filename,
    };
  }
  // file_url — Manus proxy's own format; best-effort remote-URL passthrough.
  if (part.type === "file_url") {
    if (part.file_url.mime_type === "application/pdf") {
      return { type: "document", source: { type: "url", url: part.file_url.url } };
    }
    return { type: "image", source: { type: "url", url: part.file_url.url } };
  }
  throw new Error("Unsupported message content part for Anthropic provider");
};

const buildAnthropicRequest = (messages: Message[]) => {
  let systemPrompt = "";
  const anthropicMessages: Array<{ role: "user" | "assistant"; content: unknown }> = [];

  for (const message of messages) {
    if (message.role === "system") {
      const text = ensureArray(message.content)
        .map(part => (typeof part === "string" ? part : part.type === "text" ? part.text : ""))
        .filter(Boolean)
        .join("\n\n");
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
      continue;
    }

    if (message.role === "tool" || message.role === "function") {
      const text = ensureArray(message.content)
        .map(part => (typeof part === "string" ? part : JSON.stringify(part)))
        .join("\n");
      anthropicMessages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: message.tool_call_id ?? "", content: text }],
      });
      continue;
    }

    const role = message.role === "assistant" ? "assistant" : "user";
    const parts = ensureArray(message.content);

    if (parts.length === 1 && typeof parts[0] === "string") {
      anthropicMessages.push({ role, content: parts[0] });
      continue;
    }

    const blocks = parts.map(part =>
      typeof part === "string" ? { type: "text", text: part } : toAnthropicContentBlock(part)
    );
    anthropicMessages.push({ role, content: blocks });
  }

  return { systemPrompt, anthropicMessages };
};

async function invokeAnthropic(params: InvokeParams): Promise<InvokeResult> {
  if (!ENV.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  const {
    messages,
    model,
    maxTokens,
    max_tokens,
    responseFormat,
    response_format,
    outputSchema,
    output_schema,
    tools,
    toolChoice,
    tool_choice,
  } = params;

  const { systemPrompt, anthropicMessages } = buildAnthropicRequest(messages);
  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema,
  });

  const payload: Record<string, unknown> = {
    model: model || ENV.anthropicModel,
    max_tokens: max_tokens ?? maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages: anthropicMessages,
  };
  if (systemPrompt) payload.system = systemPrompt;

  // Claude has no response_format API. Structured JSON output is obtained by
  // forcing a single tool call whose input_schema is the requested schema —
  // the model's tool_use.input then arrives as an already-parsed JSON object.
  let forcedToolName: string | undefined;
  if (normalizedResponseFormat?.type === "json_schema") {
    forcedToolName = ANTHROPIC_TOOL_NAME;
    payload.tools = [
      {
        name: ANTHROPIC_TOOL_NAME,
        description: `Emit the extraction result matching the "${normalizedResponseFormat.json_schema.name}" schema.`,
        input_schema: normalizedResponseFormat.json_schema.schema,
      },
    ];
    payload.tool_choice = { type: "tool", name: ANTHROPIC_TOOL_NAME };
  } else if (tools && tools.length > 0) {
    payload.tools = tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters ?? { type: "object", properties: {} },
    }));
    const normalizedChoice = normalizeToolChoice(toolChoice || tool_choice, tools);
    if (normalizedChoice && normalizedChoice !== "none" && normalizedChoice !== "auto") {
      payload.tool_choice = { type: "tool", name: (normalizedChoice as ToolChoiceExplicit).function.name };
    } else if (normalizedChoice === "auto") {
      payload.tool_choice = { type: "auto" };
    }
  }

  const usesPdf = anthropicMessages.some(
    m => Array.isArray((m as any).content) && (m as any).content.some((c: any) => c.type === "document")
  );

  const response = await fetchWithTimeout(resolveAnthropicUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ENV.anthropicApiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
      ...(usesPdf ? { "anthropic-beta": ANTHROPIC_PDF_BETA } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM invoke failed: ${response.status} ${response.statusText} – ${errorText}`);
  }

  const data = (await response.json()) as any;
  const blocks: any[] = Array.isArray(data.content) ? data.content : [];

  let content = "";
  const toolUseBlock = blocks.find(b => b.type === "tool_use" && (!forcedToolName || b.name === forcedToolName));
  if (toolUseBlock) {
    content = JSON.stringify(toolUseBlock.input ?? {});
  } else {
    content = blocks
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n");
  }

  const finishReasonMap: Record<string, string> = {
    end_turn: "stop",
    stop_sequence: "stop",
    max_tokens: "length",
    tool_use: "tool_calls",
  };

  return {
    id: data.id ?? `anthropic_${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model: data.model ?? (payload.model as string),
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finishReasonMap[data.stop_reason] ?? data.stop_reason ?? null,
      },
    ],
    usage: data.usage
      ? {
          prompt_tokens: data.usage.input_tokens ?? 0,
          completion_tokens: data.usage.output_tokens ?? 0,
          total_tokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// OpenRouter adapter — secondary/swap provider. OpenRouter speaks the OpenAI
// Chat Completions wire format (including the {type:"file", file:{filename,
// file_data}} PDF convention this app already used), so this path is a thin
// reuse of that shape pointed at a different base URL/key — it can reach
// Claude, Gemini, or any other OpenRouter-hosted model by changing
// OPENROUTER_MODEL alone.
// ---------------------------------------------------------------------------

const resolveOpenRouterUrl = () => "https://openrouter.ai/api/v1/chat/completions";

async function invokeOpenRouter(params: InvokeParams): Promise<InvokeResult> {
  if (!ENV.openrouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  const {
    messages,
    tools,
    toolChoice,
    tool_choice,
    outputSchema,
    output_schema,
    responseFormat,
    response_format,
    model,
    thinking,
    reasoning,
    maxTokens,
    max_tokens,
  } = params;

  const payload: Record<string, unknown> = {
    model: model || ENV.openrouterModel,
    messages: messages.map(normalizeMessage),
  };

  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  const normalizedToolChoice = normalizeToolChoice(toolChoice || tool_choice, tools);
  if (normalizedToolChoice) {
    payload.tool_choice = normalizedToolChoice;
  }

  const resolvedMaxTokens = max_tokens ?? maxTokens;
  if (typeof resolvedMaxTokens === "number") {
    payload.max_tokens = resolvedMaxTokens;
  }

  if (thinking) payload.thinking = thinking;
  if (reasoning) payload.reasoning = reasoning;

  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema,
  });
  if (normalizedResponseFormat) {
    payload.response_format = normalizedResponseFormat;
  }

  const response = await fetchWithTimeout(resolveOpenRouterUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ENV.openrouterApiKey}`,
      "HTTP-Referer": "https://nyc-dashboard-eight.vercel.app",
      "X-Title": "NYC Home Rehab Claims Dashboard",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM invoke failed: ${response.status} ${response.statusText} – ${errorText}`);
  }

  return (await response.json()) as InvokeResult;
}

// ---------------------------------------------------------------------------
// Public entry point — the single chokepoint every caller in the app talks
// to. Provider selection is entirely env-driven (AI_PROVIDER); callers never
// branch on vendor.
// ---------------------------------------------------------------------------

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  const provider = ENV.aiProvider;
  try {
    if (provider === "openrouter") {
      return await invokeOpenRouter(params);
    }
    if (provider === "anthropic") {
      return await invokeAnthropic(params);
    }
    if (provider === "openai") {
      return await invokeOpenAI(params);
    }
    throw new Error(`Unsupported AI_PROVIDER "${provider}". Use "openai", "anthropic", or "openrouter".`);
  } catch (error) {
    console.error(`[LLM:${provider}] invoke failed:`, error instanceof Error ? error.message : error);
    throw error;
  }
}

export type ModelInfo = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
};

export type ModelsResponse = {
  object: string;
  data: ModelInfo[];
};

/** Lists models from the Manus built-in proxy (BUILT_IN_FORGE_API_URL/KEY) —
 *  unrelated to the AI_PROVIDER claim-extraction path above; kept as-is for
 *  any other platform feature that still uses the forge proxy directly. */
export async function listLLMModels(): Promise<ModelsResponse> {
  if (!ENV.forgeApiKey) {
    throw new Error("BUILT_IN_FORGE_API_KEY is not configured");
  }

  const url = ENV.forgeApiUrl && ENV.forgeApiUrl.trim().length > 0
    ? `${ENV.forgeApiUrl.replace(/\/$/, "")}/v1/models`
    : "https://forge.manus.im/v1/models";

  const response = await fetchWithBackoff(url, {
    headers: { authorization: `Bearer ${ENV.forgeApiKey}` },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `List LLM models failed: ${response.status} ${response.statusText} – ${errorText}`
    );
  }

  return (await response.json()) as ModelsResponse;
}
