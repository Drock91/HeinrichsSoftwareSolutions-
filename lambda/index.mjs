/**
 * HSS Trial & Client Management — Lambda Handler (Node.js 20.x)
 * 
 * Handles trial provisioning, client management, chatbot configs, and admin ops.
 * All endpoints require Cognito JWT auth except: multi-tenant chat lookups.
 * 
 * DynamoDB Tables:
 *   HSS-CLIENTS       - Client profiles (business info, plan, status)
 *   HSS-TRIALS        - Trial tracking (start, expiry, status)
 *   HSS-CHATBOT-CONFIGS - Per-client chatbot configuration (prompt, colors, settings)
 * 
 * Environment Variables:
 *   CLIENTS_TABLE      - default: HSS-CLIENTS
 *   TRIALS_TABLE       - default: HSS-TRIALS
 *   CONFIGS_TABLE      - default: HSS-CHATBOT-CONFIGS
 *   FROM_EMAIL         - default: contact@heinrichstech.com
 *   REGION             - default: us-east-2
 */

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  ScanCommand,
  QueryCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";

// ─── CONFIG ───
const REGION = process.env.REGION || "us-east-2";
const FROM_EMAIL = process.env.FROM_EMAIL || "contact@heinrichstech.com";
const NOTIFY_EMAIL = "heinrichssoftwaresolutions@gmail.com";
const CLIENTS_TABLE = process.env.CLIENTS_TABLE || "HSS-CLIENTS";
const TRIALS_TABLE = process.env.TRIALS_TABLE || "HSS-TRIALS";
const CONFIGS_TABLE = process.env.CONFIGS_TABLE || "HSS-CHATBOT-CONFIGS";
const ANALYTICS_TABLE = process.env.ANALYTICS_TABLE || "HSS-ANALYTICS";
const SITE_URL = "https://heinrichstech.com";
const API_URL = process.env.API_URL || "https://pd30lkyyof.execute-api.us-east-2.amazonaws.com/prod";

const ses = new SESClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

// ─── INDUSTRY PROMPT TEMPLATES ───
const INDUSTRY_PROMPTS = {
  restaurant: `You are a helpful AI assistant for {businessName}. You help customers with menu questions, hours of operation, reservations, catering inquiries, and directions. Be friendly, concise, and always encourage visitors to dine in or order. If you don't know something specific, suggest they call the restaurant directly.`,
  dental: `You are a helpful AI assistant for {businessName}. You help patients with appointment scheduling, insurance questions, services offered, office hours, new patient information, and general dental care questions. Be professional, warm, and reassuring. Always recommend scheduling an appointment for specific dental concerns.`,
  legal: `You are a helpful AI assistant for {businessName}. You help potential clients understand practice areas, schedule consultations, and answer general questions about the firm. IMPORTANT: Never provide legal advice. Always recommend scheduling a consultation for specific legal matters. Be professional and empathetic.`,
  "real estate": `You are a helpful AI assistant for {businessName}. You help buyers and sellers with property inquiries, scheduling showings, understanding the buying/selling process, and connecting with agents. Be enthusiastic, knowledgeable about real estate basics, and always encourage scheduling a meeting.`,
  contractor: `You are a helpful AI assistant for {businessName}. You help customers understand services offered, request estimates, schedule consultations, and handle emergency service inquiries. For emergencies, always provide the business phone number immediately. Be professional and straightforward.`,
  ecommerce: `You are a helpful AI assistant for {businessName}. You help shoppers with product questions, sizing/fit guidance, shipping information, return policies, order tracking, and product recommendations. Be helpful, friendly, and always aim to assist the customer in making a purchase decision.`,
  general: `You are a helpful AI assistant for {businessName}. You help website visitors with questions about the business, its services, pricing, hours, location, and how to get started. Be friendly, professional, and concise. If you don't know something specific, suggest the visitor contact the business directly.`,
};

// ─── MAIN HANDLER ───
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return respond(200, {});
  }

  // Parse route
  const path = event.path || event.rawPath || "";
  const method = event.httpMethod || event.requestContext?.http?.method || "POST";
  let body = {};
  if (event.body) {
    body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  }

  // Extract user info from Cognito JWT (if authenticated)
  let claims = event.requestContext?.authorizer?.claims || {};
  
  // If no authorizer claims, parse JWT from Authorization header directly
  if (!claims.sub) {
    const authHeader = event.headers?.Authorization || event.headers?.authorization || "";
    if (authHeader) {
      try {
        const token = authHeader.replace("Bearer ", "");
        const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
        claims = payload;
      } catch (e) {
        console.warn("Failed to parse JWT:", e.message);
      }
    }
  }

  const userId = claims.sub || body.userId || null;
  const userEmail = claims.email || body.email || null;
  const userGroups = claims["cognito:groups"] || [];
  const isAdmin = Array.isArray(userGroups) ? userGroups.includes("admin") : String(userGroups).includes("admin");

  try {
    // ─── CLIENT ROUTES ───
    if (path.endsWith("/trial/signup")) {
      return await signupTrial(body);
    }
    if (path.endsWith("/trial/status")) {
      return await getTrialStatus(userId || body.userId);
    }
    if (path.endsWith("/client/profile")) {
      if (method === "GET") return await getClientProfile(userId || body.userId);
      if (method === "PUT") return await updateClientProfile(userId || body.userId, body);
    }
    if (path.endsWith("/client/chatbot-config")) {
      if (method === "GET") return await getChatbotConfig(userId || body.userId);
      if (method === "PUT") return await updateChatbotConfig(userId || body.userId, body);
    }
    if (path.endsWith("/client/analytics")) {
      return await getClientAnalytics(userId || body.userId, body);
    }

    // ─── ADMIN ROUTES ───
    if (path.endsWith("/admin/clients") && isAdmin) {
      return await listClients();
    }
    if (path.endsWith("/admin/trials") && isAdmin) {
      return await listTrials();
    }
    if (path.endsWith("/admin/update-client") && isAdmin) {
      return await adminUpdateClient(body);
    }
    if (path.endsWith("/admin/update-trial") && isAdmin) {
      return await adminUpdateTrial(body);
    }
    if (path.endsWith("/admin/update-config") && isAdmin) {
      return await adminUpdateConfig(body);
    }
    if (path.endsWith("/admin/stats") && isAdmin) {
      return await getAdminStats();
    }

    // ─── CHATBOT EMBED ROUTE (public, no auth) ───
    if (path.endsWith("/chatbot/config")) {
      return await getPublicChatbotConfig(event.queryStringParameters?.configId);
    }

    // ─── TRIAL EXPIRATION CHECK (scheduled) ───
    if (body.action === "check-expirations" || path.endsWith("/trial/check-expirations")) {
      return await checkExpirations();
    }

    // Direct invocation support
    if (body.action) {
      switch (body.action) {
        case "signup-trial": return await signupTrial(body);
        case "get-trial-status": return await getTrialStatus(body.userId);
        case "get-profile": return await getClientProfile(body.userId);
        case "update-profile": return await updateClientProfile(body.userId, body);
        case "list-clients": return await listClients();
        case "list-trials": return await listTrials();
        case "admin-update-client": return await adminUpdateClient(body);
        case "admin-update-trial": return await adminUpdateTrial(body);
        case "admin-update-config": return await adminUpdateConfig(body);
        case "admin-stats": return await getAdminStats();
        case "check-expirations": return await checkExpirations();
        default: return respond(400, { error: `Unknown action: ${body.action}` });
      }
    }

    return respond(404, { error: "Route not found" });
  } catch (err) {
    console.error("Handler error:", err);
    return respond(500, { error: err.message });
  }
};

// ───────────────────────────────────────
// TRIAL SIGNUP
// ───────────────────────────────────────
async function signupTrial(data) {
  const { userId, email, businessName, website, industry, phone, businessInfo } = data;

  if (!email || !businessName) {
    return respond(400, { error: "email and businessName are required" });
  }

  const clientId = userId || randomUUID();
  const configId = `config-${randomUUID().slice(0, 8)}`;
  const trialId = `trial-${randomUUID().slice(0, 8)}`;
  const now = new Date();
  const expiresDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 days

  // Build system prompt from industry template
  const industryKey = (industry || "general").toLowerCase();
  let systemPrompt = INDUSTRY_PROMPTS[industryKey] || INDUSTRY_PROMPTS.general;
  systemPrompt = systemPrompt.replace(/{businessName}/g, businessName);

  // Append custom business info if provided
  if (businessInfo) {
    systemPrompt += `\n\nHere is specific information about ${businessName}:\n${businessInfo}`;
  }

  // 1. Create client record
  await ddb.send(new PutCommand({
    TableName: CLIENTS_TABLE,
    Item: {
      clientId,
      email: email.toLowerCase().trim(),
      businessName: businessName.trim(),
      website: website || "",
      industry: industryKey,
      phone: phone || "",
      plan: "trial",
      status: "active",
      configId,
      trialId,
      createdAt: now.toISOString(),
    },
  }));

  // 2. Create trial record
  await ddb.send(new PutCommand({
    TableName: TRIALS_TABLE,
    Item: {
      trialId,
      clientId,
      email: email.toLowerCase().trim(),
      businessName: businessName.trim(),
      status: "active",
      startDate: now.toISOString(),
      expiresDate: expiresDate.toISOString(),
      conversationCount: 0,
      maxConversations: 50,
      createdAt: now.toISOString(),
    },
  }));

  // 3. Create chatbot config
  await ddb.send(new PutCommand({
    TableName: CONFIGS_TABLE,
    Item: {
      configId,
      clientId,
      businessName: businessName.trim(),
      systemPrompt,
      brandColor: "#FFD700",
      headerText: businessName.trim(),
      welcomeMessage: `Hi! Welcome to ${businessName}. How can I help you today?`,
      active: true,
      plan: "trial",
      createdAt: now.toISOString(),
    },
  }));

  // 4. Generate embed code
  const embedCode = `<!-- ${businessName} AI Chatbot by HSS -->\n<script src="${SITE_URL}/chatbot-embed.js" data-config="${configId}"></script>`;

  // 5. Email the customer their embed code + instructions (non-blocking)
  try {
    await ses.send(new SendEmailCommand({
      Source: `Heinrichs Software Solutions <${FROM_EMAIL}>`,
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: `Your AI Chatbot is Ready! — ${businessName}` },
        Body: {
          Text: {
            Data: `Hi!

Your free 14-day AI chatbot trial for ${businessName} is ready!

INSTALLATION (takes 30 seconds):
1. Copy the code below
2. Paste it just before </body> on your website
3. That's it — your chatbot is live!

─── YOUR EMBED CODE ───
${embedCode}
───────────────────────

TRIAL DETAILS:
• Trial expires: ${expiresDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
• Conversations included: 100
• Your config ID: ${configId}

MANAGE YOUR TRIAL:
Dashboard: ${SITE_URL}/dashboard.html

The chatbot is already trained on your business type (${industry || "general"}). Want us to customize it further with your specific services, pricing, and FAQs? Just reply to this email with your business details and we'll update it within 24 hours.

Questions? Reply to this email or call (619) 770-7306.

HSS Team
Heinrichs Software Solutions Company
${SITE_URL}`,
          },
        },
      },
    }));
  } catch (emailErr) {
    console.warn("Failed to send customer email:", emailErr.message);
  }

  // 6. Notify admin (non-blocking)
  try {
    await ses.send(new SendEmailCommand({
      Source: `HSS Trial System <${FROM_EMAIL}>`,
      Destination: { ToAddresses: [NOTIFY_EMAIL] },
      Message: {
        Subject: { Data: `🎉 New Trial Signup: ${businessName}` },
        Body: {
          Text: {
            Data: `New trial signup!\n\nBusiness: ${businessName}\nEmail: ${email}\nWebsite: ${website || "N/A"}\nIndustry: ${industry || "general"}\nPhone: ${phone || "N/A"}\nConfig ID: ${configId}\nTrial ID: ${trialId}\nExpires: ${expiresDate.toISOString()}\n\nDashboard: ${SITE_URL}/admin.html`,
          },
        },
      },
    }));
  } catch (emailErr) {
    console.warn("Failed to send admin notification:", emailErr.message);
  }

  return respond(200, {
    message: "Trial created successfully!",
    trialId,
    configId,
    embedCode,
    expiresDate: expiresDate.toISOString(),
  });
}

// ───────────────────────────────────────
// TRIAL STATUS
// ───────────────────────────────────────
async function getTrialStatus(userId) {
  if (!userId) return respond(400, { error: "userId required" });

  // Find client first
  const client = await getClientByIdOrEmail(userId);
  if (!client) return respond(404, { error: "Client not found" });

  if (!client.trialId) return respond(200, { status: "no-trial" });

  const result = await ddb.send(new GetCommand({
    TableName: TRIALS_TABLE,
    Key: { trialId: client.trialId },
  }));

  if (!result.Item) return respond(404, { error: "Trial not found" });

  const trial = result.Item;
  const now = new Date();
  const expires = new Date(trial.expiresDate);
  const daysLeft = Math.max(0, Math.ceil((expires - now) / (1000 * 60 * 60 * 24)));

  return respond(200, {
    ...trial,
    daysLeft,
    isExpired: now > expires,
  });
}

// ───────────────────────────────────────
// CLIENT PROFILE
// ───────────────────────────────────────
async function getClientProfile(userId) {
  if (!userId) return respond(400, { error: "userId required" });
  const client = await getClientByIdOrEmail(userId);
  if (!client) return respond(404, { error: "Client not found" });
  return respond(200, client);
}

async function updateClientProfile(userId, data) {
  if (!userId) return respond(400, { error: "userId required" });

  const updates = {};
  const names = {};
  const values = {};
  let expr = [];

  if (data.businessName) { expr.push("#bn = :bn"); names["#bn"] = "businessName"; values[":bn"] = data.businessName; }
  if (data.website) { expr.push("#ws = :ws"); names["#ws"] = "website"; values[":ws"] = data.website; }
  if (data.phone) { expr.push("#ph = :ph"); names["#ph"] = "phone"; values[":ph"] = data.phone; }
  if (data.industry) { expr.push("#ind = :ind"); names["#ind"] = "industry"; values[":ind"] = data.industry; }
  if (data.businessInfo) { expr.push("#bi = :bi"); names["#bi"] = "businessInfo"; values[":bi"] = data.businessInfo; }

  if (expr.length === 0) return respond(400, { error: "Nothing to update" });

  await ddb.send(new UpdateCommand({
    TableName: CLIENTS_TABLE,
    Key: { clientId: userId },
    UpdateExpression: "SET " + expr.join(", "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));

  // Also update chatbot config headerText if businessName changed
  if (data.businessName) {
    const client = await getClientByIdOrEmail(userId);
    if (client && client.configId) {
      await ddb.send(new UpdateCommand({
        TableName: CONFIGS_TABLE,
        Key: { configId: client.configId },
        UpdateExpression: "SET #ht = :ht, #bn = :bn",
        ExpressionAttributeNames: { "#ht": "headerText", "#bn": "businessName" },
        ExpressionAttributeValues: { ":ht": data.businessName, ":bn": data.businessName },
      }));
    }
  }

  return respond(200, { message: "Profile updated" });
}

async function getChatbotConfig(userId) {
  if (!userId) return respond(400, { error: "userId required" });
  const client = await getClientByIdOrEmail(userId);
  if (!client || !client.configId) return respond(404, { error: "No chatbot config found" });

  const result = await ddb.send(new GetCommand({
    TableName: CONFIGS_TABLE,
    Key: { configId: client.configId },
  }));

  return respond(200, result.Item || {});
}

// ───────────────────────────────────────
// CLIENT: UPDATE CHATBOT CONFIG
// ───────────────────────────────────────
async function updateChatbotConfig(userId, data) {
  if (!userId) return respond(400, { error: "userId required" });

  const client = await getClientByIdOrEmail(userId);
  if (!client || !client.configId) return respond(404, { error: "No chatbot config found" });

  // Only allow the client to update their own config
  const configId = client.configId;

  const updates = [];
  const names = {};
  const values = {};

  const allowed = ["welcomeMessage", "brandColor", "headerColor", "headerText", "businessInfo", "position"];
  let idx = 0;
  for (const key of allowed) {
    if (data[key] !== undefined && data[key] !== null) {
      const alias = `#f${idx}`;
      const valAlias = `:v${idx}`;
      idx++;
      // Map businessInfo → systemPrompt in DynamoDB
      const dbKey = key === "businessInfo" ? "systemPrompt" : key;
      updates.push(`${alias} = ${valAlias}`);
      names[alias] = dbKey;
      values[valAlias] = data[key];
    }
  }

  if (updates.length === 0) return respond(400, { error: "Nothing to update" });

  await ddb.send(new UpdateCommand({
    TableName: CONFIGS_TABLE,
    Key: { configId },
    UpdateExpression: "SET " + updates.join(", "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));

  return respond(200, { message: "Config updated" });
}

// ───────────────────────────────────────
// CLIENT: GET ANALYTICS (Pro feature)
// ───────────────────────────────────────
async function getClientAnalytics(userId, params = {}) {
  if (!userId) return respond(400, { error: "userId required" });
  
  const client = await getClientByIdOrEmail(userId);
  if (!client) return respond(404, { error: "Client not found" });
  
  // Check if client has Pro plan (paid or comped)
  const isProPaid = client.plan === 'pro' || client.subscriptionStatus === 'active';
  const isCompedPro = client.compedPlan === 'pro' && client.compedUntil && new Date(client.compedUntil) > new Date();
  
  if (!isProPaid && !isCompedPro) {
    return respond(403, { error: "Analytics dashboard requires Pro plan" });
  }
  
  // Query analytics for this client
  const days = parseInt(params.days) || 30;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  
  const result = await ddb.send(new QueryCommand({
    TableName: ANALYTICS_TABLE,
    KeyConditionExpression: "clientId = :cid AND #ts >= :start",
    ExpressionAttributeNames: { "#ts": "timestamp" },
    ExpressionAttributeValues: {
      ":cid": client.clientId,
      ":start": startDate.toISOString(),
    },
    ScanIndexForward: false, // newest first
    Limit: 1000,
  }));
  
  const events = result.Items || [];
  
  // Aggregate data
  const totalConversations = events.length;
  const totalMessages = events.reduce((sum, e) => sum + 1, 0);
  const avgUserMsgLength = events.length ? Math.round(events.reduce((sum, e) => sum + (e.userMessageLength || 0), 0) / events.length) : 0;
  const avgAiReplyLength = events.length ? Math.round(events.reduce((sum, e) => sum + (e.aiReplyLength || 0), 0) / events.length) : 0;
  
  // Group by day
  const byDay = {};
  const byHour = Array(24).fill(0);
  const byDayOfWeek = Array(7).fill(0);
  const providers = {};
  
  events.forEach(e => {
    // By date
    const dateKey = e.timestamp.split('T')[0];
    byDay[dateKey] = (byDay[dateKey] || 0) + 1;
    
    // By hour
    const hour = e.hour || 0;
    byHour[hour]++;
    
    // By day of week
    const dow = e.dayOfWeek || 0;
    byDayOfWeek[dow]++;
    
    // By provider
    const prov = e.provider || 'unknown';
    providers[prov] = (providers[prov] || 0) + 1;
  });
  
  // Recent conversations (last 10)
  const recentConversations = events.slice(0, 10).map(e => ({
    timestamp: e.timestamp,
    preview: e.userMessagePreview || '',
    provider: e.provider,
  }));
  
  // Peak hours (top 3)
  const peakHours = byHour
    .map((count, hour) => ({ hour, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map(h => `${h.hour}:00`);
  
  return respond(200, {
    period: `Last ${days} days`,
    totalConversations,
    totalMessages,
    avgUserMsgLength,
    avgAiReplyLength,
    conversationsByDay: byDay,
    conversationsByHour: byHour,
    conversationsByDayOfWeek: byDayOfWeek,
    providerUsage: providers,
    peakHours,
    recentConversations,
  });
}

// ───────────────────────────────────────
// PUBLIC CHATBOT CONFIG (for embed script)
// ───────────────────────────────────────
async function getPublicChatbotConfig(configId) {
  if (!configId) return respond(400, { error: "configId required" });

  const result = await ddb.send(new GetCommand({
    TableName: CONFIGS_TABLE,
    Key: { configId },
  }));

  if (!result.Item || !result.Item.active) {
    return respond(404, { error: "Chatbot not found or inactive" });
  }

  // Only return public-facing config (not the full system prompt)
  const config = result.Item;
  return respond(200, {
    configId: config.configId,
    businessName: config.businessName,
    brandColor: config.brandColor,
    headerColor: config.headerColor,
    headerText: config.headerText,
    welcomeMessage: config.welcomeMessage,
    position: config.position,
    plan: config.plan,
  });
}

// ───────────────────────────────────────
// ADMIN: LIST ALL CLIENTS
// ───────────────────────────────────────
async function listClients() {
  const result = await ddb.send(new ScanCommand({ TableName: CLIENTS_TABLE }));
  const clients = (result.Items || []).sort((a, b) =>
    new Date(b.createdAt) - new Date(a.createdAt)
  );
  return respond(200, { clients, count: clients.length });
}

// ───────────────────────────────────────
// ADMIN: LIST ALL TRIALS
// ───────────────────────────────────────
async function listTrials() {
  const result = await ddb.send(new ScanCommand({ TableName: TRIALS_TABLE }));
  const trials = (result.Items || []).sort((a, b) =>
    new Date(b.createdAt) - new Date(a.createdAt)
  );
  return respond(200, { trials, count: trials.length });
}

// ───────────────────────────────────────
// ADMIN: UPDATE CLIENT
// ───────────────────────────────────────
async function adminUpdateClient(data) {
  if (!data.clientId) return respond(400, { error: "clientId required" });

  const updates = [];
  const names = {};
  const values = {};

  const allowed = ["plan", "status", "businessName", "website", "industry", "phone"];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      const alias = `#${key.slice(0, 3)}`;
      const valAlias = `:${key.slice(0, 3)}`;
      updates.push(`${alias} = ${valAlias}`);
      names[alias] = key;
      values[valAlias] = data[key];
    }
  }

  if (updates.length === 0) return respond(400, { error: "Nothing to update" });

  await ddb.send(new UpdateCommand({
    TableName: CLIENTS_TABLE,
    Key: { clientId: data.clientId },
    UpdateExpression: "SET " + updates.join(", "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));

  return respond(200, { message: "Client updated" });
}

// ───────────────────────────────────────
// ADMIN: UPDATE TRIAL
// ───────────────────────────────────────
async function adminUpdateTrial(data) {
  if (!data.trialId) return respond(400, { error: "trialId required" });

  const updates = [];
  const names = {};
  const values = {};

  if (data.status) { updates.push("#st = :st"); names["#st"] = "status"; values[":st"] = data.status; }
  if (data.expiresDate) { updates.push("#ex = :ex"); names["#ex"] = "expiresDate"; values[":ex"] = data.expiresDate; }
  if (data.maxConversations) { updates.push("#mx = :mx"); names["#mx"] = "maxConversations"; values[":mx"] = data.maxConversations; }

  if (updates.length === 0) return respond(400, { error: "Nothing to update" });

  await ddb.send(new UpdateCommand({
    TableName: TRIALS_TABLE,
    Key: { trialId: data.trialId },
    UpdateExpression: "SET " + updates.join(", "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));

  return respond(200, { message: "Trial updated" });
}

// ───────────────────────────────────────
// ADMIN: UPDATE CHATBOT CONFIG
// ───────────────────────────────────────
async function adminUpdateConfig(data) {
  if (!data.configId) return respond(400, { error: "configId required" });

  const updates = [];
  const names = {};
  const values = {};

  const allowed = ["systemPrompt", "brandColor", "headerText", "welcomeMessage", "active", "plan"];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      const alias = `#${key.slice(0, 4)}`;
      const valAlias = `:${key.slice(0, 4)}`;
      updates.push(`${alias} = ${valAlias}`);
      names[alias] = key;
      values[valAlias] = data[key];
    }
  }

  if (updates.length === 0) return respond(400, { error: "Nothing to update" });

  await ddb.send(new UpdateCommand({
    TableName: CONFIGS_TABLE,
    Key: { configId: data.configId },
    UpdateExpression: "SET " + updates.join(", "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));

  return respond(200, { message: "Config updated" });
}

// ───────────────────────────────────────
// ADMIN: DASHBOARD STATS
// ───────────────────────────────────────
async function getAdminStats() {
  const [clientsRes, trialsRes] = await Promise.all([
    ddb.send(new ScanCommand({ TableName: CLIENTS_TABLE })),
    ddb.send(new ScanCommand({ TableName: TRIALS_TABLE })),
  ]);

  const clients = clientsRes.Items || [];
  const trials = trialsRes.Items || [];
  const now = new Date();

  return respond(200, {
    totalClients: clients.length,
    activeTrials: trials.filter(t => t.status === "active" && new Date(t.expiresDate) > now).length,
    expiredTrials: trials.filter(t => t.status === "expired" || new Date(t.expiresDate) <= now).length,
    paidClients: clients.filter(c => c.plan === "standard" || c.plan === "pro").length,
    byPlan: {
      trial: clients.filter(c => c.plan === "trial").length,
      standard: clients.filter(c => c.plan === "standard").length,
      pro: clients.filter(c => c.plan === "pro").length,
    },
    byIndustry: clients.reduce((acc, c) => { acc[c.industry || "general"] = (acc[c.industry || "general"] || 0) + 1; return acc; }, {}),
  });
}

// ───────────────────────────────────────
// TRIAL EXPIRATION CHECKER (scheduled)
// ───────────────────────────────────────
async function checkExpirations() {
  const now = new Date();
  const result = await ddb.send(new ScanCommand({
    TableName: TRIALS_TABLE,
    FilterExpression: "#st = :active",
    ExpressionAttributeNames: { "#st": "status" },
    ExpressionAttributeValues: { ":active": "active" },
  }));

  let expired = 0;
  let expiringSoon = 0;

  for (const trial of result.Items || []) {
    const expiresDate = new Date(trial.expiresDate);
    const daysLeft = Math.ceil((expiresDate - now) / (1000 * 60 * 60 * 24));

    // Expired — deactivate
    if (daysLeft <= 0) {
      await ddb.send(new UpdateCommand({
        TableName: TRIALS_TABLE,
        Key: { trialId: trial.trialId },
        UpdateExpression: "SET #st = :expired",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: { ":expired": "expired" },
      }));

      // Deactivate chatbot config
      const client = await ddb.send(new ScanCommand({
        TableName: CLIENTS_TABLE,
        FilterExpression: "trialId = :tid",
        ExpressionAttributeValues: { ":tid": trial.trialId },
      }));
      if (client.Items?.[0]?.configId) {
        await ddb.send(new UpdateCommand({
          TableName: CONFIGS_TABLE,
          Key: { configId: client.Items[0].configId },
          UpdateExpression: "SET active = :false",
          ExpressionAttributeValues: { ":false": false },
        }));
      }

      // Email customer
      try {
        await ses.send(new SendEmailCommand({
          Source: `Heinrichs Software Solutions <${FROM_EMAIL}>`,
          Destination: { ToAddresses: [trial.email] },
          Message: {
            Subject: { Data: `Your AI Chatbot Trial Has Ended — ${trial.businessName}` },
            Body: {
              Text: {
                Data: `Hi,\n\nYour 14-day free trial for ${trial.businessName}'s AI chatbot has ended.\n\nWant to keep it? Upgrade to a paid plan:\n• Standard: $499 setup + $49/month\n• Pro: $999 setup + $99/month\n\nUpgrade here: ${SITE_URL}/dashboard.html\n\nYour chatbot has been paused but all your data and training is saved. Upgrading reactivates it instantly.\n\nQuestions? Reply to this email or call (619) 770-7306.\n\nHSS Team\nHeinrichs Software Solutions Company`,
              },
            },
          },
        }));
      } catch (emailErr) { console.warn("Expiry email failed:", emailErr.message); }

      expired++;
    }
    // Expiring in 3 days — send warning
    else if (daysLeft <= 3 && daysLeft > 0) {
      try {
        await ses.send(new SendEmailCommand({
          Source: `Heinrichs Software Solutions <${FROM_EMAIL}>`,
          Destination: { ToAddresses: [trial.email] },
          Message: {
            Subject: { Data: `⏰ Your AI Chatbot Trial Expires in ${daysLeft} Day${daysLeft === 1 ? "" : "s"}` },
            Body: {
              Text: {
                Data: `Hi,\n\nJust a heads-up: your free chatbot trial for ${trial.businessName} expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.\n\nDon't lose your AI chatbot! Upgrade to keep it running:\n${SITE_URL}/contact.html?subject=chatbot-standard\n\nYour chatbot data and training will be saved either way.\n\nHSS Team\n(619) 770-7306`,
              },
            },
          },
        }));
      } catch (emailErr) { console.warn("Warning email failed:", emailErr.message); }
      expiringSoon++;
    }
  }

  // Notify admin
  if (expired > 0 || expiringSoon > 0) {
    try {
      await ses.send(new SendEmailCommand({
        Source: `HSS Trial System <${FROM_EMAIL}>`,
        Destination: { ToAddresses: [NOTIFY_EMAIL] },
        Message: {
          Subject: { Data: `Trial Check: ${expired} expired, ${expiringSoon} expiring soon` },
          Body: {
            Text: { Data: `Trial expiration check complete.\n\nExpired (deactivated): ${expired}\nExpiring in 3 days (warning sent): ${expiringSoon}\n\nDashboard: ${SITE_URL}/admin.html` },
          },
        },
      }));
    } catch (emailErr) { console.warn("Admin notification failed:", emailErr.message); }
  }

  return respond(200, { expired, expiringSoon });
}

// ───────────────────────────────────────
// HELPERS
// ───────────────────────────────────────
async function getClientByIdOrEmail(idOrEmail) {
  // Try by clientId first
  const byId = await ddb.send(new GetCommand({
    TableName: CLIENTS_TABLE,
    Key: { clientId: idOrEmail },
  }));
  if (byId.Item) return byId.Item;

  // Try by email scan
  const byEmail = await ddb.send(new ScanCommand({
    TableName: CLIENTS_TABLE,
    FilterExpression: "email = :email",
    ExpressionAttributeValues: { ":email": idOrEmail.toLowerCase() },
  }));
  return byEmail.Items?.[0] || null;
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}
