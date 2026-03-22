/**
 * HSS AI Chatbot — Lambda Handler (Node.js)
 * Multi-provider AI with automatic failover.
 * Client-aware: loads custom config, enforces trial limits, tracks conversations.
 * Priority: Google Gemini (free) → Groq (free) → Mistral → OpenAI → Anthropic
 */

import { DynamoDBClient, GetItemCommand, UpdateItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const REGION = process.env.AWS_REGION || "us-east-2";
const ddb = new DynamoDBClient({ region: REGION });
const ses = new SESClient({ region: REGION });

const TABLE_CONFIGS   = process.env.TABLE_CONFIGS   || "HSS-CHATBOT-CONFIGS";
const TABLE_CLIENTS   = process.env.TABLE_CLIENTS   || "HSS-CLIENTS";
const TABLE_TRIALS    = process.env.TABLE_TRIALS    || "HSS-TRIALS";
const TABLE_ANALYTICS = process.env.TABLE_ANALYTICS || "HSS-ANALYTICS";
const TABLE_LEADS     = process.env.TABLE_LEADS     || "HSS-LEADS";
const TABLE_CONVOS    = process.env.TABLE_CONVOS    || "HSS-CONVERSATIONS";

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
- Email: contact@heinrichstech.com
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
- Encourage visitors to use the Contact page or email contact@heinrichstech.com
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
//  CONVERSATION STORAGE + AGENT TAKEOVER
// ══════════════════════════════════════════════════════

// Get or create conversation record
async function getConversation(clientId, sessionId) {
  if (!clientId || !sessionId) return null;
  
  try {
    const res = await ddb.send(new GetItemCommand({
      TableName: TABLE_CONVOS,
      Key: { clientId: { S: clientId }, sessionId: { S: sessionId } },
    }));
    
    if (res.Item) {
      return {
        clientId: res.Item.clientId?.S,
        sessionId: res.Item.sessionId?.S,
        messages: res.Item.messages?.S ? JSON.parse(res.Item.messages.S) : [],
        status: res.Item.status?.S || 'active',
        agentName: res.Item.agentName?.S || null,
        lastActivity: res.Item.lastActivity?.S,
        customerPreview: res.Item.customerPreview?.S || '',
        agentJoinedNotified: res.Item.agentJoinedNotified?.BOOL || false,
      };
    }
  } catch (err) {
    console.warn('Get conversation error:', err.message);
  }
  return null;
}

// Save/update conversation
async function saveConversation(clientId, sessionId, messages, status = 'active', agentName = null, customerPreview = '') {
  return saveConversationWithNotify(clientId, sessionId, messages, status, agentName, customerPreview, false);
}

// Save conversation with optional agentJoinedNotified flag
async function saveConversationWithNotify(clientId, sessionId, messages, status = 'active', agentName = null, customerPreview = '', agentJoinedNotified = false) {
  if (!clientId || !sessionId) return;
  
  try {
    await ddb.send(new PutItemCommand({
      TableName: TABLE_CONVOS,
      Item: {
        clientId: { S: clientId },
        sessionId: { S: sessionId },
        messages: { S: JSON.stringify(messages) },
        status: { S: status },
        lastActivity: { S: new Date().toISOString() },
        ...(agentName && { agentName: { S: agentName } }),
        ...(customerPreview && { customerPreview: { S: customerPreview } }),
        ...(agentJoinedNotified && { agentJoinedNotified: { BOOL: true } }),
      },
    }));
  } catch (err) {
    console.warn('Save conversation error:', err.message);
  }
}

// Check if agent has pending messages for this session
async function checkAgentMessages(clientId, sessionId) {
  const convo = await getConversation(clientId, sessionId);
  if (!convo) return { agentTakeover: false, pendingMessages: [], alreadyNotified: false };
  
  // If agent is active, return their pending messages
  if (convo.status === 'agent_active' && convo.agentName) {
    // Find messages from agent that might be waiting
    const agentMsgs = convo.messages.filter(m => m.role === 'agent' && !m.delivered);
    return { 
      agentTakeover: true, 
      agentName: convo.agentName,
      pendingMessages: agentMsgs,
      alreadyNotified: convo.agentJoinedNotified || false
    };
  }
  
  return { agentTakeover: false, pendingMessages: [], alreadyNotified: false };
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

  // Build system prompt: personality (behavior instructions) + knowledge base (site content)
  let systemPrompt = DEFAULT_SYSTEM_PROMPT;
  const personality = config.personality || '';
  const knowledgeBase = config.systemPrompt || '';

  if (personality && knowledgeBase) {
    systemPrompt = personality + '\n\n--- KNOWLEDGE BASE ---\n' + knowledgeBase;
  } else if (personality) {
    systemPrompt = personality;
  } else if (knowledgeBase) {
    systemPrompt = knowledgeBase;
  }

  const discordWebhook = config.discordWebhook || null;
  const businessName = config.businessName || config.headerText || 'Customer';

  // Track if this is a new session (for Discord notifications)
  let isNewConversation = false;
  if (sessionId && discordWebhook) {
    try {
      // Try to add session to config's counted sessions
      await ddb.send(new UpdateItemCommand({
        TableName: TABLE_CONFIGS,
        Key: { configId: { S: configId } },
        UpdateExpression: "ADD notifiedSessions :sessSet",
        ConditionExpression: "attribute_not_exists(notifiedSessions) OR NOT contains(notifiedSessions, :sid)",
        ExpressionAttributeValues: {
          ":sessSet": { SS: [sessionId] },
          ":sid": { S: sessionId },
        },
      }));
      isNewConversation = true;
      console.log(`New conversation for Discord notification: session=${sessionId} config=${configId}`);
    } catch (err) {
      if (err.name !== "ConditionalCheckFailedException") {
        console.warn("Session notification tracking error:", err.message);
      }
      // Session already notified - that's fine
    }
  }

  // 2. Fetch client record
  if (!config.clientId) return { systemPrompt, discordWebhook, businessName, isNewConversation };

  const clientRes = await ddb.send(new GetItemCommand({
    TableName: TABLE_CLIENTS,
    Key: { clientId: { S: config.clientId } },
  }));

  if (!clientRes.Item) return { systemPrompt, discordWebhook, businessName, isNewConversation };
  const client = unmarshal(clientRes.Item);

  // 3. Paid plans — no limits, just use their prompt
  if (client.plan !== "trial") return { systemPrompt, discordWebhook, businessName, isNewConversation };

  // 3.5. Comped/Free plans — check if still valid
  if (client.compedPlan && client.compedUntil) {
    const compedExpires = new Date(client.compedUntil);
    if (new Date() < compedExpires) {
      // Still within free period, treat as paid
      console.log(`Comped ${client.compedPlan} plan active until ${client.compedUntil} for client ${client.clientId}`);
      return { systemPrompt, discordWebhook, businessName, isNewConversation };
    } else {
      console.log(`Comped plan expired for client ${client.clientId}`);
    }
  }

  // 4. Trial plan — enforce limits
  if (!client.trialId) return { systemPrompt, discordWebhook, businessName, isNewConversation };

  const trialRes = await ddb.send(new GetItemCommand({
    TableName: TABLE_TRIALS,
    Key: { trialId: { S: client.trialId } },
  }));

  if (!trialRes.Item) return { systemPrompt, discordWebhook, businessName, isNewConversation };
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

  // 5. Track unique session as one conversation (for trial limits)
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

  return { systemPrompt, discordWebhook, businessName, isNewConversation };
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

  // Get user's LATEST message (last user message in the array)
  const userMessages = cleanMessages.filter(m => m.role === 'user');
  const userMessage = userMessages.length > 0 ? userMessages[userMessages.length - 1].content : '';

  // ── Resolve system prompt + enforce trial limits ──
  let systemPrompt = DEFAULT_SYSTEM_PROMPT;
  let discordWebhook = null;
  let businessName = 'Customer';
  let isNewConversation = false;
  let clientId = null;

  if (configId) {
    try {
      // Get clientId from config
      const cfgRes = await ddb.send(new GetItemCommand({
        TableName: TABLE_CONFIGS,
        Key: { configId: { S: configId } },
      }));
      if (cfgRes.Item?.clientId?.S) {
        clientId = cfgRes.Item.clientId.S;
      }

      // ── Domain restriction: only allow chatbot on authorized websites ──
      if (cfgRes.Item?.allowedDomains?.S) {
        const rawOrigin = (event.headers?.origin || event.headers?.Origin || event.headers?.referer || event.headers?.Referer || '').toLowerCase();
        const allowedList = cfgRes.Item.allowedDomains.S.split(',').map(d => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/:\d+$/, '')).filter(Boolean);
        if (allowedList.length > 0) {
          const originHost = rawOrigin.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
          const domainOk = allowedList.some(d => originHost === d || originHost.endsWith('.' + d));
          if (!domainOk) {
            console.warn(`Domain rejected: origin="${originHost}" allowed=[${allowedList}] configId=${configId}`);
            return respond(403, { error: "This chatbot is not authorized for this domain." });
          }
        }
      } else {
        // No allowedDomains configured — block in production (except HSS website itself)
        const rawOrigin = (event.headers?.origin || event.headers?.Origin || event.headers?.referer || event.headers?.Referer || '').toLowerCase();
        const originHost = rawOrigin.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
        if (originHost && !originHost.includes('heinrichstech.com') && !originHost.includes('localhost')) {
          console.warn(`No allowedDomains configured, blocking external origin="${originHost}" configId=${configId}`);
          return respond(403, { error: "This chatbot has no authorized domains configured. Please set up allowed domains in your dashboard." });
        }
      }

      const resolved = await resolveClientConfig(configId, sessionId);

      // If the resolver returned a canned reply (inactive/expired/over-limit),
      // send it directly without calling any AI provider
      if (resolved.reply) {
        return respond(200, { reply: resolved.reply });
      }

      if (resolved.systemPrompt) {
        systemPrompt = resolved.systemPrompt;
      }
      if (resolved.discordWebhook) {
        discordWebhook = resolved.discordWebhook;
      }
      if (resolved.businessName) {
        businessName = resolved.businessName;
      }
      isNewConversation = resolved.isNewConversation || false;
      
      // ── Check for agent takeover ──
      if (clientId && sessionId) {
        const agentCheck = await checkAgentMessages(clientId, sessionId);
        if (agentCheck.agentTakeover) {
          // Agent has taken over - save user message
          const convo = await getConversation(clientId, sessionId);
          const msgs = convo?.messages || [];
          msgs.push({ role: 'user', content: userMessage, timestamp: new Date().toISOString() });
          
          // Update customerPreview to latest user message
          const latestUserMsg = userMessage.slice(0, 100);
          
          // Only show "joined" notification if this is the first message after takeover
          if (!agentCheck.alreadyNotified) {
            await saveConversationWithNotify(clientId, sessionId, msgs, 'agent_active', agentCheck.agentName, latestUserMsg, true);
          } else {
            // Already notified - just save message
            await saveConversationWithNotify(clientId, sessionId, msgs, 'agent_active', agentCheck.agentName, latestUserMsg, true);
          }
          
          // Return empty response - widget shows agent banner and will poll for replies
          return respond(200, { 
            reply: '',
            agentActive: true,
            agentName: agentCheck.agentName,
            waitingForAgent: true
          });
        }
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
      
      // Log analytics event (fire and forget)
      if (configId) {
        logAnalyticsEvent(configId, userMessage, reply, provider.name).catch(e => console.warn('Analytics log failed:', e.message));
        
        // Check for lead capture (fire and forget)
        const conversationContext = cleanMessages.map(m => `${m.role}: ${m.content}`).join('\n');
        checkAndSaveLead(configId, cleanMessages, conversationContext).catch(e => console.warn('Lead capture failed:', e.message));
        
        // Send Discord notification for new conversations (fire and forget)
        if (isNewConversation && discordWebhook) {
          sendDiscordNotification(discordWebhook, businessName, userMessage).catch(e => console.warn('Discord notification failed:', e.message));
        }
        
        // Save conversation for live chat (fire and forget)
        if (clientId && sessionId) {
          const convo = await getConversation(clientId, sessionId);
          const msgs = convo?.messages || [];
          msgs.push({ role: 'user', content: userMessage, timestamp: new Date().toISOString() });
          msgs.push({ role: 'assistant', content: reply, timestamp: new Date().toISOString() });
          // Use the latest user message for preview (not the first)
          saveConversation(clientId, sessionId, msgs, 'active', null, userMessage.slice(0, 100))
            .catch(e => console.warn('Save conversation failed:', e.message));
        }
      }
      
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

// ══════════════════════════════════════════════════════
//  ANALYTICS LOGGING
// ══════════════════════════════════════════════════════
async function logAnalyticsEvent(configId, userMessage, aiReply, provider) {
  // Look up clientId from configId
  const configRes = await ddb.send(new GetItemCommand({
    TableName: TABLE_CONFIGS,
    Key: { configId: { S: configId } },
  }));
  
  const clientId = configRes.Item?.clientId?.S;
  if (!clientId) return;
  
  const timestamp = new Date().toISOString();
  const hour = new Date().getHours();
  const dayOfWeek = new Date().getDay(); // 0=Sun, 6=Sat
  
  await ddb.send(new PutItemCommand({
    TableName: TABLE_ANALYTICS,
    Item: {
      clientId: { S: clientId },
      timestamp: { S: timestamp },
      eventType: { S: "conversation" },
      configId: { S: configId },
      provider: { S: provider },
      userMessageLength: { N: String(userMessage.length) },
      aiReplyLength: { N: String(aiReply.length) },
      hour: { N: String(hour) },
      dayOfWeek: { N: String(dayOfWeek) },
      // Store first 200 chars for topic analysis (optional)
      userMessagePreview: { S: userMessage.slice(0, 200) },
    },
  }));
  
  console.log(`Analytics logged for client ${clientId}`);
}

// ══════════════════════════════════════════════════════
//  DISCORD WEBHOOK NOTIFICATIONS
// ══════════════════════════════════════════════════════
async function sendDiscordNotification(webhookUrl, businessName, userMessage) {
  if (!webhookUrl || !webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
    console.log('Discord webhook skipped - invalid URL:', webhookUrl?.slice(0, 50));
    return;
  }
  
  const msgPreview = userMessage?.slice(0, 500) || '(empty message)';
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  
  const payload = {
    username: 'HSS Chatbot',
    embeds: [{
      title: "💬 New Chat Started",
      description: "Someone started a conversation with your chatbot!",
      color: 0xF1C40F,
      fields: [{ name: "First Message", value: msgPreview, inline: false }],
      footer: { text: `${businessName} • ${ts}` },
      timestamp: new Date().toISOString()
    }]
  };
  
  try {
    console.log('Sending Discord notification to:', webhookUrl.slice(0, 60) + '...');
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    if (!resp.ok) {
      const errText = await resp.text();
      console.warn(`Discord webhook failed (${resp.status}):`, errText);
    } else {
      console.log('Discord notification sent successfully');
    }
  } catch (err) {
    console.warn('Discord webhook error:', err.message);
  }
}

// ══════════════════════════════════════════════════════
//  LEAD CAPTURE & EMAIL NOTIFICATIONS
// ══════════════════════════════════════════════════════

// Regex patterns for contact info extraction
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
const PHONE_REGEX = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g;
const NAME_PATTERNS = [
  /(?:my name is|i'm|i am|this is|call me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
  /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+here/i,
];

function extractContactInfo(messages) {
  const allText = messages
    .filter(m => m.role === 'user')
    .map(m => m.content)
    .join(' ');
  
  const emails = allText.match(EMAIL_REGEX) || [];
  const phones = allText.match(PHONE_REGEX) || [];
  
  let name = null;
  for (const pattern of NAME_PATTERNS) {
    const match = allText.match(pattern);
    if (match && match[1]) {
      name = match[1].trim();
      break;
    }
  }
  
  // Return null if no contact info found
  if (!emails.length && !phones.length) {
    return null;
  }
  
  return {
    email: emails[0] || null,
    phone: phones[0] || null,
    name: name,
  };
}

async function checkAndSaveLead(configId, messages, conversationContext) {
  const contactInfo = extractContactInfo(messages);
  if (!contactInfo) return;
  
  // Look up client info
  const configRes = await ddb.send(new GetItemCommand({
    TableName: TABLE_CONFIGS,
    Key: { configId: { S: configId } },
  }));
  
  const config = configRes.Item ? {
    clientId: configRes.Item.clientId?.S,
    businessName: configRes.Item.businessName?.S || 'Your Business',
  } : null;
  
  if (!config?.clientId) return;
  
  // Get client record for notification email and plan check
  const clientRes = await ddb.send(new GetItemCommand({
    TableName: TABLE_CLIENTS,
    Key: { clientId: { S: config.clientId } },
  }));
  
  const client = clientRes.Item ? {
    plan: clientRes.Item.plan?.S,
    notificationEmail: clientRes.Item.notificationEmail?.S || clientRes.Item.email?.S,
    compedPlan: clientRes.Item.compedPlan?.S,
  } : null;
  
  // Only Pro plan (or comped pro) gets lead capture
  const effectivePlan = client?.compedPlan || client?.plan;
  if (effectivePlan !== 'pro') {
    console.log(`Lead capture skipped - client ${config.clientId} is not on Pro plan (plan: ${effectivePlan})`);
    return;
  }
  
  const timestamp = new Date().toISOString();
  const leadId = `lead-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  
  // Save lead to DynamoDB
  await ddb.send(new PutItemCommand({
    TableName: TABLE_LEADS,
    Item: {
      clientId: { S: config.clientId },
      timestamp: { S: timestamp },
      leadId: { S: leadId },
      configId: { S: configId },
      email: contactInfo.email ? { S: contactInfo.email } : { NULL: true },
      phone: contactInfo.phone ? { S: contactInfo.phone } : { NULL: true },
      name: contactInfo.name ? { S: contactInfo.name } : { NULL: true },
      conversationPreview: { S: conversationContext.slice(0, 500) },
      status: { S: 'new' },
    },
  }));
  
  console.log(`Lead saved: ${leadId} for client ${config.clientId}`);
  
  // Send email notification
  if (client?.notificationEmail) {
    await sendLeadNotification(
      client.notificationEmail,
      config.businessName,
      contactInfo,
      conversationContext
    );
  }
}

async function sendLeadNotification(toEmail, businessName, contactInfo, conversationContext) {
  const subject = `🔥 New Lead from ${businessName} AI Chatbot`;
  
  const htmlBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333;">New Lead Captured!</h2>
      <p>Your AI chatbot just captured a potential customer's contact information:</p>
      
      <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
        ${contactInfo.name ? `<p><strong>Name:</strong> ${contactInfo.name}</p>` : ''}
        ${contactInfo.email ? `<p><strong>Email:</strong> <a href="mailto:${contactInfo.email}">${contactInfo.email}</a></p>` : ''}
        ${contactInfo.phone ? `<p><strong>Phone:</strong> <a href="tel:${contactInfo.phone}">${contactInfo.phone}</a></p>` : ''}
      </div>
      
      <h3 style="color: #666;">Conversation Summary:</h3>
      <div style="background: #fafafa; padding: 15px; border-left: 3px solid #d4af37; margin: 15px 0;">
        <pre style="white-space: pre-wrap; font-family: inherit; margin: 0;">${conversationContext.slice(0, 1000)}</pre>
      </div>
      
      <p style="color: #888; font-size: 12px; margin-top: 30px;">
        This lead was captured by your AI chatbot powered by Heinrichs Software Solutions.<br>
        <a href="https://heinrichstech.com/dashboard.html">View all leads in your dashboard</a>
      </p>
    </div>
  `;
  
  const textBody = `
New Lead Captured!

Your AI chatbot just captured a potential customer's contact information:

${contactInfo.name ? `Name: ${contactInfo.name}\n` : ''}${contactInfo.email ? `Email: ${contactInfo.email}\n` : ''}${contactInfo.phone ? `Phone: ${contactInfo.phone}\n` : ''}

Conversation Summary:
${conversationContext.slice(0, 1000)}

---
This lead was captured by your AI chatbot powered by Heinrichs Software Solutions.
View all leads at: https://heinrichstech.com/dashboard.html
  `;
  
  try {
    await ses.send(new SendEmailCommand({
      Source: 'HSS AI Chatbot <noreply@heinrichstech.com>',
      Destination: {
        ToAddresses: [toEmail],
      },
      Message: {
        Subject: { Data: subject },
        Body: {
          Html: { Data: htmlBody },
          Text: { Data: textBody },
        },
      },
    }));
    console.log(`Lead notification sent to ${toEmail}`);
  } catch (err) {
    console.error(`Failed to send lead notification: ${err.message}`);
  }
}
