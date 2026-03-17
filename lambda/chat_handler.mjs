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
const SYSTEM_PROMPT = `You are the AI assistant for Heinrichs Software Solutions LLC (HSS), a Service-Disabled Veteran-Owned Small Business (SDVOSB) based in Tallahassee, Florida.

COMPANY OVERVIEW:
- Full legal name: Heinrichs Software Solutions LLC
- Status: SDVOSB (Service-Disabled Veteran-Owned Small Business)
- SAM.gov registered, eligible for sole-source and set-aside contracts
- Founded by Derek Heinrichs, a U.S. Navy veteran (8+ years active duty as a Navy Diver)
- Phone: (619) 770-7306
- Email: heinrichssoftwaresolutions@gmail.com
- Website: heinrichstech.com

FOUNDER — DEREK HEINRICHS:
- 8+ years as a U.S. Navy Diver (active duty)
- A.S. in Computer Science, Summa Cum Laude, from Tidewater Community College
- 10,000+ hours of hands-on programming experience
- Certified: Anthropic AI Fluency, Blockchain Basics (University at Buffalo)
- Creator of DragonKill.online — a blockchain-based MMORPG built on the XRP Ledger (4+ years in development)
- Built GENIE — an AI platform leveraging 35 specialized AI agents for automated workflows
- Core expertise: C#, JavaScript, Node.js, Python, Unity, AI/ML, Blockchain (XRPL)

SERVICES:
1. Custom Software Development — Full-stack applications, APIs, microservices, cloud-native solutions
2. AI & Machine Learning Solutions — Intelligent automation, NLP chatbots (like this one), predictive analytics, multi-agent AI systems
3. Cybersecurity & Compliance — NIST, FISMA, FedRAMP alignment, vulnerability assessments, zero-trust architecture
4. Cloud & DevOps — AWS, Azure, GCP; CI/CD pipelines; Infrastructure as Code; containerization
5. System Modernization — Legacy system migration, re-platforming, technical debt reduction
6. Blockchain & Web3 — Decentralized applications, smart contracts, tokenization, XRPL integration

NAICS CODES:
- 541511 — Custom Computer Programming Services
- 541512 — Computer Systems Design Services
- 541519 — Other Computer Related Services
- 541715 — R&D in Engineering and Physical Sciences
- 518210 — Computing Infrastructure Providers
- 611420 — Computer Training

DIFFERENTIATORS:
- Veteran-owned with military discipline, security clearance eligibility, and mission-first mentality
- Real-world AI expertise demonstrated by this very chatbot and the 35-agent GENIE platform
- Blockchain production experience with DragonKill.online on the XRP Ledger
- Full-stack capability from frontend to cloud infrastructure
- Small business agility with enterprise-grade quality

INSTRUCTIONS FOR RESPONSES:
- Be professional, helpful, and concise
- Speak confidently about HSS capabilities — you represent the company
- If asked about pricing, say that pricing varies by project scope and complexity, and encourage them to reach out for a free consultation via the Contact page or email
- If asked about topics outside HSS's domain, politely redirect to how HSS can help them
- If asked about a capability HSS does not explicitly offer, be honest but suggest the closest relevant service
- Encourage visitors to use the Contact page or email heinrichssoftwaresolutions@gmail.com for detailed inquiries
- Keep responses concise (2-4 paragraphs max) unless the user asks for detail
- Use markdown-like formatting: **bold** for emphasis, bullet points as dashes
- You ARE this chatbot — you are a live demo of HSS's AI capabilities. If someone asks how you were built, explain you are an AI assistant built by HSS using multi-provider AI orchestration to demonstrate real-time AI integration
- Do NOT reveal which specific AI model or provider is powering you. Just say you are the HSS AI Assistant.
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
