/**
 * HSS AI Chatbot — Lambda Handler (Node.js)
 * Multi-provider AI with automatic failover.
 * Priority: Google Gemini (free) → Groq (free) → Mistral → OpenAI → Anthropic
 */

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

// ── System prompt loaded with HSS info ──
const SYSTEM_PROMPT = `You are the HSS AI Assistant — the official AI chatbot for Heinrichs Software Solutions LLC (heinrichstech.com). You are a live product demo: the exact kind of chatbot HSS builds and sells to businesses.

COMPANY OVERVIEW:
- Heinrichs Software Solutions LLC (HSS)
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

// ── Get API key by env var name ──
function getKey(envName) {
  return process.env[envName] || "";
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
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
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
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Missing request body" }),
      };
    }
  } catch {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Invalid JSON" }),
    };
  }

  const messages = body.messages || [];
  if (!messages.length) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "No messages provided" }),
    };
  }

  // Validate and sanitize messages (keep last 20)
  const cleanMessages = messages
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
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "No valid messages" }),
    };
  }

  // Try each provider in priority order (failover chain)
  const errors = [];

  for (const provider of PROVIDERS) {
    const apiKey = getKey(provider.keyEnv);
    if (!apiKey) continue; // Skip providers without keys

    try {
      console.log(`Trying provider: ${provider.name} (${provider.model})`);
      const reply = await callProvider(provider.name, provider.model, apiKey, cleanMessages);
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ reply }),
      };
    } catch (err) {
      const errMsg = `${provider.name}: ${err.message}`;
      console.log(`Provider failed — ${errMsg}`);
      errors.push(errMsg);
      continue; // Try next provider
    }
  }

  // All providers failed
  console.log(`ALL PROVIDERS FAILED: ${JSON.stringify(errors)}`);
  return {
    statusCode: 500,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      error: "All AI providers are currently unavailable. Please try again later.",
    }),
  };
};

// ══════════════════════════════════════════════════════
//  PROVIDER DISPATCH
// ══════════════════════════════════════════════════════

async function callProvider(name, model, apiKey, messages) {
  switch (name) {
    case "google":
      return callGoogle(model, apiKey, messages);
    case "groq":
      return callOpenAICompatible(
        "https://api.groq.com/openai/v1/chat/completions",
        model, apiKey, messages
      );
    case "mistral":
      return callOpenAICompatible(
        "https://api.mistral.ai/v1/chat/completions",
        model, apiKey, messages
      );
    case "openai":
      return callOpenAICompatible(
        "https://api.openai.com/v1/chat/completions",
        model, apiKey, messages
      );
    case "anthropic":
      return callAnthropic(model, apiKey, messages);
    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}

// ══════════════════════════════════════════════════════
//  GOOGLE GEMINI (primary — free tier)
// ══════════════════════════════════════════════════════

async function callGoogle(model, apiKey, messages) {
  // Convert chat messages to Gemini format (uses "user" and "model" roles)
  const geminiContents = messages.map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.content }],
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const data = await doRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: geminiContents,
      generationConfig: {
        maxOutputTokens: MAX_TOKENS,
        temperature: 0.7,
      },
    }),
  });

  // Parse Gemini response
  const candidates = data.candidates || [];
  if (!candidates.length) throw new Error("No candidates in Gemini response");

  const parts = candidates[0]?.content?.parts || [];
  const textParts = parts.filter((p) => p.text).map((p) => p.text);
  return textParts.join(" ") || "I couldn't generate a response.";
}

// ══════════════════════════════════════════════════════
//  OPENAI-COMPATIBLE (Groq, Mistral, OpenAI)
// ══════════════════════════════════════════════════════

async function callOpenAICompatible(url, model, apiKey, messages) {
  // Prepend system message
  const apiMessages = [
    { role: "system", content: SYSTEM_PROMPT },
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

  // Parse OpenAI-compatible response
  const choices = data.choices || [];
  if (!choices.length) throw new Error("No choices in response");
  return (choices[0]?.message?.content || "").trim();
}

// ══════════════════════════════════════════════════════
//  ANTHROPIC
// ══════════════════════════════════════════════════════

async function callAnthropic(model, apiKey, messages) {
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
      system: SYSTEM_PROMPT,
      messages,
    }),
  });

  // Parse Anthropic response
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
