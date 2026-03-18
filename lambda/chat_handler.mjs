/**
 * HSS AI Chatbot — Lambda Handler (Node.js)
 * Multi-provider AI with automatic failover.
 * Client-aware: loads custom config, enforces trial limits, tracks conversations.
 * Priority: Google Gemini (free) → Groq (free) → Mistral → OpenAI → Anthropic
 */

import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-2";
const ddb = new DynamoDBClient({ region: REGION });

const TABLE_CONFIGS = process.env.TABLE_CONFIGS || "HSS-CHATBOT-CONFIGS";
const TABLE_CLIENTS = process.env.TABLE_CLIENTS || "HSS-CLIENTS";
const TABLE_TRIALS  = process.env.TABLE_TRIALS  || "HSS-TRIALS";

// ── API Keys (from Lambda env vars) ──
const GOOGLE_API_KEY    = process.env.GOOGLE_API_KEY || "";
const GROQ_API_KEY      = process.env.GROQ_API_KEY || "";
const MISTRAL_API_KEY   = process.env.MISTRAL_API_KEY || "";
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

const MAX_TOKENS = parseInt(process.env.CHAT_MAX_TOKENS || "1024", 10);

// ── Provider configs: tried in order ──
const PROVIDERS = [
  {
    name: "google",
    keyEnv: "GOOGLE_API_KEY",
    model: "gemini-2.0-flash",
  },
  {
    name: "groq",
    keyEnv: "GROQ_API_KEY",
    model: "llama-3.3-70b-versatile",
  },
  {
    name: "mistral",
    keyEnv: "MISTRAL_API_KEY",
    model: "mistral-small-latest",
  },
  {
    name: "openai",
    keyEnv: "OPENAI_API_KEY",
    model: "gpt-4o-mini",
  },
  {
    name: "anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    model: "claude-sonnet-4-20250514",
  },
];

// ── Default system prompt (HSS website chatbot — no configId) ──
const DEFAULT_SYSTEM_PROMPT = `You are the HSS AI Assistant — the official AI chatbot for Heinrichs Software Solutions Company (heinrichstech.com). You are a live product demo: the exact kind of chatbot HSS builds and sells to businesses.

COMPANY OVERVIEW:
- Heinrichs Software Solutions Company (HSS)
- Founded by Derek Heinrichs — U.S. Navy veteran (8+ years active duty as a Navy Diver), full-stack developer with 10,000+ hours of hands-on programming experience
- Based in Florida, serving clients nationwide and remotely
- Veteran-owned (SDVOSB certified) — military discipline, accountability, and mission-first mentality in every project
- Phone: (619) 770-7306
- Email: heinrichssoftwaresolutions@gmail.com
- Website: heinrichstech.com

WHAT WE DO (Lead with AI, then full-stack):

1. **AI Chatbots** (Our flagship product) — Custom AI assistants like this one, trained on YOUR business data, deployed on your website in days. Multi-provider AI (Google, OpenAI, Anthropic) with automatic failover for 99.9% uptime. Brand-matched design. Starting from $499.
   - 24/7 customer support automation
   - Lead capture and qualification
   - FAQ handling, appointment scheduling, product recommendations
   - Serverless backend — scales to any traffic, near-zero idle cost
   - We handle setup, training, deployment, and ongoing updates

2. **AI Automation & Workflows** — Custom AI-powered systems that automate repetitive business processes. We built GENIE, a 35-agent AI orchestration platform — we bring that same multi-agent expertise to your business.
   - Document processing and summarization
   - Email triage and auto-response systems
   - Data extraction and report generation
   - Content generation pipelines
   - AI-powered internal tools for your team

3. **Custom Software Development** — Full-stack web apps, APIs, microservices, and enterprise platforms. Node.js, Python, React, .NET, C# — whatever the project demands.
   - Web applications and dashboards
   - RESTful & GraphQL APIs
   - Database design and optimization
   - Third-party integrations (CRMs, payment processors, etc.)

4. **Cloud & DevOps** — AWS, Azure, GCP architecture, CI/CD pipelines, container orchestration, infrastructure as code.

5. **Web3 & Blockchain** — Decentralized apps, smart contracts, XRPL integration. Creator of DragonKill.online, a blockchain MMORPG on the XRP Ledger.

WHO WE WORK WITH:
- Small businesses wanting their first AI chatbot
- Startups needing MVPs built fast
- E-commerce stores wanting automated customer support
- Agencies and consultancies needing white-label AI tools
- Enterprises requiring custom software or AI automation
- Anyone who needs code written well and delivered on time

PRICING GUIDANCE:
- AI Chatbots start at $499 for a standard deployment
- For custom software, AI automation, and larger projects — pricing depends on scope and complexity
- Always encourage them to reach out for a **free consultation** via the Contact page or email
- We offer ongoing maintenance and support plans

FOUNDER CREDENTIALS (use when building trust):
- Anthropic AI Fluency certified
- Blockchain Basics certified (University at Buffalo)
- Built GENIE — a multi-agent AI platform with 35+ specialized AI agents
- Built DragonKill.online — a blockchain MMORPG on the XRP Ledger (4+ years in development)
- Core stack: JavaScript/Node.js, Python, React, C#/Unity, AI/ML, XRPL

RESPONSE RULES:
- Be professional, friendly, and confident — you represent HSS
- Keep responses concise: 2-4 short paragraphs max unless the user asks for detail
- Use **bold** for emphasis and dashes for bullet points
- ALWAYS tie the conversation back to how HSS can help them
- When someone asks about chatbots, get excited — this is our bread and butter. Mention they're literally talking to one right now as proof of concept
- If asked about pricing, give the $499 starting point for chatbots, and "free consultation" for everything else
- If asked about topics outside our services, politely redirect
- If asked about a capability we don't explicitly offer, be honest but suggest the closest service we do offer
- Encourage visitors to use the Contact page or email heinrichssoftwaresolutions@gmail.com
- You ARE this chatbot — you are a live demo of what we sell. If anyone asks how you were built, explain you're a custom AI assistant built by HSS using multi-provider AI orchestration with automatic failover — and that HSS builds these for businesses every day
- Do NOT reveal which specific AI model or provider powers you. Say you are the "HSS AI Assistant" powered by HSS's multi-provider AI system
- If someone says they want a chatbot like you, that's a hot lead — enthusiastically guide them to contact us
`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

// ── Simple DynamoDB item → JS object ──
function unmarshal(item) {
  const obj = {};
  for (const [k, v] of Object.entries(item)) {
    if (v.S  !== undefined) obj[k] = v.S;
    else if (v.N  !== undefined) obj[k] = Number(v.N);
    else if (v.BOOL !== undefined) obj[k] = v.BOOL;
    else if (v.SS !== undefined) obj[k] = new Set(v.SS);
    else if (v.NULL) obj[k] = null;
  }
  return obj;
}

// ── Convenience response builder ──
function respond(statusCode, body) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

// ── Get API key by env var name ──
function getKey(envName) {
  return process.env[envName] || "";
}

// ══════════════════════════════════════════════════════
//  CLIENT CONFIG + TRIAL ENFORCEMENT
// ══════════════════════════════════════════════════════

async function resolveClientConfig(configId, sessionId) {
  // 1. Fetch chatbot config
  const cfgRes = await ddb.send(new GetItemCommand({
    TableName: TABLE_CONFIGS,
    Key: { configId: { S: configId } },
  }));

  if (!cfgRes.Item) {
    return { reply: "I'm sorry, this chatbot could not be found. Please contact the business for assistance." };
  }

  const config = unmarshal(cfgRes.Item);

  if (!config.active) {
    return {
      reply: "I'm sorry, this chatbot is currently offline. The free trial may have expired — please contact the business for more information.",
    };
  }

  const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

  // 2. Fetch client record
  if (!config.clientId) return { systemPrompt };

  const clientRes = await ddb.send(new GetItemCommand({
    TableName: TABLE_CLIENTS,
    Key: { clientId: { S: config.clientId } },
  }));

  if (!clientRes.Item) return { systemPrompt };
  const client = unmarshal(clientRes.Item);

  // 3. Paid plans — no limits, just use their prompt
  if (client.plan !== "trial") return { systemPrompt };

  // 4. Trial plan — enforce limits
  if (!client.trialId) return { systemPrompt };

  const trialRes = await ddb.send(new GetItemCommand({
    TableName: TABLE_TRIALS,
    Key: { trialId: { S: client.trialId } },
  }));

  if (!trialRes.Item) return { systemPrompt };
  const trial = unmarshal(trialRes.Item);

  // Check expiration
  if (trial.status === "expired" || new Date() > new Date(trial.expiresDate)) {
    return {
      reply: "I'm sorry, this chatbot's free trial has ended. Please contact the business to continue using this service.",
    };
  }

  // Check conversation limit
  const count = trial.conversationCount || 0;
  const max   = trial.maxConversations  || 50;

  if (count >= max) {
    return {
      reply: "I'm sorry, this chatbot has reached its free trial conversation limit. Please contact the business to continue using this service.",
    };
  }

  // 5. Track unique session as one conversation
  if (sessionId) {
    try {
      await ddb.send(new UpdateItemCommand({
        TableName: TABLE_TRIALS,
        Key: { trialId: { S: client.trialId } },
        UpdateExpression:
          "SET conversationCount = if_not_exists(conversationCount, :zero) + :one " +
          "ADD countedSessions :sessSet",
        ConditionExpression:
          "attribute_not_exists(countedSessions) OR NOT contains(countedSessions, :sid)",
        ExpressionAttributeValues: {
          ":zero":    { N: "0" },
          ":one":     { N: "1" },
          ":sessSet": { SS: [sessionId] },
          ":sid":     { S: sessionId },
        },
      }));
      console.log(`New conversation tracked: session=${sessionId} count=${count + 1}/${max} trial=${client.trialId}`);
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        // Session already counted — that's fine, continue
      } else {
        console.error("Session tracking error:", err.message);
      }
    }
  }

  return { systemPrompt };
}

// ══════════════════════════════════════════════════════
//  LAMBDA HANDLER
// ══════════════════════════════════════════════════════

export const handler = async (event) => {
  // Handle CORS preflight
  const method = event.httpMethod
    || event?.requestContext?.http?.method
    || "";
  if (method === "OPTIONS") {
    return respond(200, "");
  }

  // Parse request body
  let body;
  try {
    const rawBody = event.body;
    if (typeof rawBody === "string") {
      body = JSON.parse(rawBody);
    } else if (typeof rawBody === "object" && rawBody !== null) {
      body = rawBody;
    } else {
      return respond(400, { error: "Missing request body" });
    }
  } catch {
    return respond(400, { error: "Invalid JSON" });
  }

  // ── Extract fields ──
  // chatbot.js sends: { messages: [{role,content}] }
  // chatbot-embed.js sends: { configId, sessionId, history: [{role,content}], message }
  const configId  = body.configId  || null;
  const sessionId = body.sessionId || null;
  const rawMessages = body.messages || body.history || [];

  if (!rawMessages.length) {
    return respond(400, { error: "No messages provided" });
  }

  // Validate and sanitize messages (keep last 20)
  const cleanMessages = rawMessages
    .slice(-20)
    .filter(
      (msg) =>
        ["user", "assistant"].includes(msg.role) &&
        typeof msg.content === "string" &&
        msg.content.trim()
    )
    .map((msg) => ({
      role: msg.role,
      content: msg.content.trim().slice(0, 2000),
    }));

  if (!cleanMessages.length) {
    return respond(400, { error: "No valid messages" });
  }

  // ── Resolve system prompt + enforce trial limits ──
  let systemPrompt = DEFAULT_SYSTEM_PROMPT;

  if (configId) {
    try {
      const resolved = await resolveClientConfig(configId, sessionId);

      // If the resolver returned a canned reply (inactive/expired/over-limit),
      // send it directly without calling any AI provider
      if (resolved.reply) {
        return respond(200, { reply: resolved.reply });
      }

      if (resolved.systemPrompt) {
        systemPrompt = resolved.systemPrompt;
      }
    } catch (err) {
      console.error("Config/trial lookup failed:", err.message);
      // Don't block the chat — fall back to default prompt
    }
  }

  // ── Try each provider in priority order (failover chain) ──
  const errors = [];

  for (const provider of PROVIDERS) {
    const apiKey = getKey(provider.keyEnv);
    if (!apiKey) continue;

    try {
      console.log(`Trying provider: ${provider.name} (${provider.model})`);
      const reply = await callProvider(provider.name, provider.model, apiKey, cleanMessages, systemPrompt);
      return respond(200, { reply });
    } catch (err) {
      const errMsg = `${provider.name}: ${err.message}`;
      console.log(`Provider failed — ${errMsg}`);
      errors.push(errMsg);
      continue;
    }
  }

  // All providers failed
  console.log(`ALL PROVIDERS FAILED: ${JSON.stringify(errors)}`);
  return respond(500, {
    error: "All AI providers are currently unavailable. Please try again later.",
  });
};

// ══════════════════════════════════════════════════════
//  PROVIDER DISPATCH
// ══════════════════════════════════════════════════════

async function callProvider(name, model, apiKey, messages, systemPrompt) {
  switch (name) {
    case "google":
      return callGoogle(model, apiKey, messages, systemPrompt);
    case "groq":
      return callOpenAICompatible(
        "https://api.groq.com/openai/v1/chat/completions",
        model, apiKey, messages, systemPrompt
      );
    case "mistral":
      return callOpenAICompatible(
        "https://api.mistral.ai/v1/chat/completions",
        model, apiKey, messages, systemPrompt
      );
    case "openai":
      return callOpenAICompatible(
        "https://api.openai.com/v1/chat/completions",
        model, apiKey, messages, systemPrompt
      );
    case "anthropic":
      return callAnthropic(model, apiKey, messages, systemPrompt);
    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}

// ══════════════════════════════════════════════════════
//  GOOGLE GEMINI (primary — free tier)
// ══════════════════════════════════════════════════════

async function callGoogle(model, apiKey, messages, systemPrompt) {
  const geminiContents = messages.map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.content }],
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const data = await doRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: geminiContents,
      generationConfig: {
        maxOutputTokens: MAX_TOKENS,
        temperature: 0.7,
      },
    }),
  });

  const candidates = data.candidates || [];
  if (!candidates.length) throw new Error("No candidates in Gemini response");

  const parts = candidates[0]?.content?.parts || [];
  const textParts = parts.filter((p) => p.text).map((p) => p.text);
  return textParts.join(" ") || "I couldn't generate a response.";
}

// ══════════════════════════════════════════════════════
//  OPENAI-COMPATIBLE (Groq, Mistral, OpenAI)
// ══════════════════════════════════════════════════════

async function callOpenAICompatible(url, model, apiKey, messages, systemPrompt) {
  const apiMessages = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

  const data = await doRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      temperature: 0.7,
      messages: apiMessages,
    }),
  });

  const choices = data.choices || [];
  if (!choices.length) throw new Error("No choices in response");
  return (choices[0]?.message?.content || "").trim();
}

// ══════════════════════════════════════════════════════
//  ANTHROPIC
// ══════════════════════════════════════════════════════

async function callAnthropic(model, apiKey, messages, systemPrompt) {
  const data = await doRequest("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages,
    }),
  });

  const contentBlocks = data.content || [];
  const textParts = contentBlocks
    .filter((b) => b.type === "text")
    .map((b) => b.text);
  return textParts.join(" ") || "I couldn't generate a response.";
}

// ══════════════════════════════════════════════════════
//  SHARED HTTP HELPER (uses native fetch in Node 20.x)
// ══════════════════════════════════════════════════════

async function doRequest(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    const text = await response.text();

    if (!response.ok) {
      console.log(`HTTP ${response.status}: ${text.slice(0, 500)}`);
      throw new Error(`HTTP ${response.status}`);
    }

    return JSON.parse(text);
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("Request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
