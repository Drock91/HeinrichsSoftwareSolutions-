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
const NOTIFY_EMAIL = "contact@heinrichstech.com";
const CLIENTS_TABLE = process.env.CLIENTS_TABLE || "HSS-CLIENTS";
const TRIALS_TABLE = process.env.TRIALS_TABLE || "HSS-TRIALS";
const CONFIGS_TABLE = process.env.CONFIGS_TABLE || "HSS-CHATBOT-CONFIGS";
const ANALYTICS_TABLE = process.env.ANALYTICS_TABLE || "HSS-ANALYTICS";
const LEADS_TABLE = process.env.LEADS_TABLE || "HSS-LEADS";
const CONVOS_TABLE = process.env.CONVOS_TABLE || "HSS-CONVERSATIONS";
const SITE_URL = "https://heinrichstech.com";
const API_URL = process.env.API_URL || "https://pd30lkyyof.execute-api.us-east-2.amazonaws.com/prod";

const ses = new SESClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const ALLOWED_ORIGINS = [
  "https://heinrichstech.com",
  "https://www.heinrichstech.com",
];

function getCorsHeaders(origin) {
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Credentials": "true",
  };
}

// ─── SSRF PROTECTION ───
function isPrivateIp(hostname) {
  // Block private/internal IPs to prevent SSRF attacks
  const parts = hostname.split('.');
  if (parts.length === 4 && parts.every(p => /^\d+$/.test(p))) {
    const [a, b] = parts.map(Number);
    if (a === 10) return true;                    // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;       // 192.168.0.0/16
    if (a === 127) return true;                    // 127.0.0.0/8
    if (a === 169 && b === 254) return true;       // 169.254.0.0/16 (metadata)
    if (a === 0) return true;                      // 0.0.0.0/8
  }
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
  return false;
}

// Module-level variable removed — pass origin per-request to avoid race conditions

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
  // Determine origin per-request (no module-level variable)
  const origin = event.headers?.origin || event.headers?.Origin || "";
  const requestOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  if (event.httpMethod === "OPTIONS") {
    return respond(200, {}, requestOrigin);
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
    console.log("Auth header received:", authHeader ? authHeader.substring(0, 100) : "EMPTY");
    if (authHeader && authHeader.length > 10) {
      try {
        const token = authHeader.replace("Bearer ", "").trim();
        const parts = token.split(".");
        if (parts.length >= 2 && parts[1]) {
          // Try base64url first, then standard base64
          let payloadStr;
          try {
            payloadStr = Buffer.from(parts[1], "base64url").toString("utf8");
          } catch {
            // Fallback: convert base64url chars to standard base64
            const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
            payloadStr = Buffer.from(b64, "base64").toString("utf8");
          }
          const payload = JSON.parse(payloadStr);
          claims = payload;
          console.log("Parsed JWT claims:", { sub: claims.sub, email: claims.email });
        } else {
          console.warn("Invalid JWT structure, parts:", parts.length);
        }
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
    if (path.endsWith("/client/leads")) {
      return await getClientLeads(userId || body.userId, body);
    }
    if (path.endsWith("/client/import-url") && method === "POST") {
      return await importUrlContent(body.url);
    }
    if (path.endsWith("/client/import-sitemap") && method === "POST") {
      return await importSitemap(body.url);
    }
    
    // ─── LIVE CHAT ROUTES ───
    if (path.endsWith("/client/conversations")) {
      return await getClientConversations(userId || body.userId);
    }
    if (path.includes("/client/conversation/") && method === "GET") {
      const sessionId = path.split("/client/conversation/")[1];
      return await getConversation(userId || body.userId, sessionId);
    }
    if (path.endsWith("/client/conversation/reply") && method === "POST") {
      return await agentReply(userId || body.userId, body);
    }
    if (path.endsWith("/client/conversation/takeover") && method === "POST") {
      return await agentTakeover(userId || body.userId, body);
    }
    if (path.endsWith("/client/conversation/release") && method === "POST") {
      return await agentRelease(userId || body.userId, body);
    }
    if (path.endsWith("/client/conversation/typing") && method === "POST") {
      return await agentTyping(userId || body.userId, body);
    }
    if (path.endsWith("/client/conversation/end") && method === "POST") {
      return await agentEndConversation(userId || body.userId, body);
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
    if (path.endsWith("/admin/get-config") && isAdmin) {
      return await adminGetConfig(body);
    }
    if (path.endsWith("/admin/stats") && isAdmin) {
      return await getAdminStats();
    }

    // ─── CHATBOT EMBED ROUTE (public, no auth) ───
    if (path.endsWith("/chatbot/config")) {
      return await getPublicChatbotConfig(event.queryStringParameters?.configId);
    }
    
    // ─── WIDGET AGENT POLL (public, no auth) ───
    if (path.endsWith("/chatbot/agent-poll") && method === "POST") {
      return await widgetAgentPoll(body.configId, body.sessionId);
    }
    
    // ─── WIDGET CHAT CLOSE (public, no auth) ───
    if (path.endsWith("/chatbot/close") && method === "POST") {
      return await widgetChatClose(body.configId, body.sessionId);
    }
    if (path.endsWith("/chatbot/heartbeat") && method === "POST") {
      return await widgetHeartbeat(body.configId, body.sessionId);
    }

    // ─── TRIAL EXPIRATION CHECK (scheduled) ───
    if (body.action === "check-expirations" || path.endsWith("/trial/check-expirations")) {
      return await checkExpirations();
    }

    // ─── COMP EXPIRATION CHECK (scheduled) ───
    if (body.action === "check-comp-expirations" || path.endsWith("/trial/check-comp-expirations")) {
      return await checkCompExpirations();
    }

    // ─── UNSUBSCRIBE FROM EMAILS (public, no auth) ───
    if (path.endsWith("/unsubscribe") && method === "POST") {
      return await unsubscribeFromEmails(body.clientId);
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
        case "check-comp-expirations": return await checkCompExpirations();
        case "unsubscribe": return await unsubscribeFromEmails(body.clientId);
        default: return respond(400, { error: `Unknown action: ${body.action}` });
      }
    }

    return respond(404, { error: "Route not found" }, requestOrigin);
  } catch (err) {
    console.error("Handler error:", err);
    return respond(500, { error: "Internal server error" }, requestOrigin);
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

  // Input validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return respond(400, { error: "Invalid email format" });
  }
  if (email.length > 320) return respond(400, { error: "Email too long" });
  if (businessName.length > 200) return respond(400, { error: "Business name too long (max 200)" });
  if (website && website.length > 500) return respond(400, { error: "Website URL too long" });
  if (phone && phone.length > 30) return respond(400, { error: "Phone too long" });
  if (businessInfo && businessInfo.length > 50000) return respond(400, { error: "Business info too long (max 50,000 chars)" });

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
• Conversations included: 50
• Your config ID: ${configId}

MANAGE YOUR TRIAL:
Dashboard: ${SITE_URL}/dashboard.html

The chatbot is already trained on your business type (${industry || "general"}). Want us to customize it further with your specific services, pricing, and FAQs? Just reply to this email with your business details and we'll update it within 24 hours.

Questions? Reply to this email.

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
  if (data.emailNotifications !== undefined) { expr.push("#en = :en"); names["#en"] = "emailNotifications"; values[":en"] = data.emailNotifications; }

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

// ───────────────────────────────────────
// PUBLIC: UNSUBSCRIBE FROM EMAILS
// ───────────────────────────────────────
async function unsubscribeFromEmails(clientId) {
  if (!clientId) return respond(400, { error: "clientId required" });

  try {
    await ddb.send(new UpdateCommand({
      TableName: CLIENTS_TABLE,
      Key: { clientId: clientId },
      UpdateExpression: "SET emailNotifications = :false",
      ExpressionAttributeValues: { ":false": false },
    }));

    return respond(200, { message: "Successfully unsubscribed from email notifications" });
  } catch (err) {
    console.error("Unsubscribe error:", err);
    return respond(500, { error: "Failed to unsubscribe" });
  }
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

  // ── Validate allowedDomains count against plan limits ──
  if (data.allowedDomains !== undefined && data.allowedDomains !== null) {
    const domainStr = data.allowedDomains.trim();
    if (domainStr) {
      // Count unique root domains (strip www. prefix for dedup)
      const roots = new Set(
        domainStr.split(',').map(d => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/:\d+$/, '').replace(/^www\./, '')).filter(Boolean)
      );
      // Determine plan limits: trial/standard = 1 root domain, pro = 3
      const plan = client.plan || 'trial';
      const isPaid = client.subscriptionStatus === 'active' || client.subscriptionStatus === 'canceling';
      const isComped = client.compedPlan && client.compedUntil && new Date(client.compedUntil) > new Date();
      const effectivePlan = isComped ? client.compedPlan : plan;
      const maxDomains = (effectivePlan === 'pro' && (isPaid || isComped)) ? 3 : 1;
      if (roots.size > maxDomains) {
        return respond(400, { error: `Your ${effectivePlan === 'pro' ? 'Pro' : 'Standard/Trial'} plan allows ${maxDomains} domain${maxDomains > 1 ? 's' : ''}. You entered ${roots.size}. Upgrade to add more.` });
      }
    }
  }

  const allowed = ["welcomeMessage", "brandColor", "headerColor", "headerText", "personality", "businessInfo", "position", "discordWebhook", "allowedDomains"];
  let idx = 0;
  for (const key of allowed) {
    if (data[key] !== undefined && data[key] !== null) {
      const alias = `#f${idx}`;
      const valAlias = `:v${idx}`;
      idx++;
      // Map businessInfo → systemPrompt in DynamoDB, personality stays as-is
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
// CLIENT: GET LEADS (Pro feature)
// ───────────────────────────────────────
async function getClientLeads(userId, params = {}) {
  if (!userId) return respond(400, { error: "userId required" });
  
  const client = await getClientByIdOrEmail(userId);
  if (!client) return respond(404, { error: "Client not found" });
  
  // Check if client has Pro plan (paid or comped)
  const isProPaid = client.plan === 'pro' || client.subscriptionStatus === 'active';
  const isCompedPro = client.compedPlan === 'pro' && client.compedUntil && new Date(client.compedUntil) > new Date();
  
  if (!isProPaid && !isCompedPro) {
    return respond(403, { error: "Lead capture requires Pro plan" });
  }
  
  // Query leads for this client
  const days = parseInt(params.days) || 30;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  
  const result = await ddb.send(new QueryCommand({
    TableName: LEADS_TABLE,
    KeyConditionExpression: "clientId = :cid AND #ts >= :start",
    ExpressionAttributeNames: { "#ts": "timestamp" },
    ExpressionAttributeValues: {
      ":cid": client.clientId,
      ":start": startDate.toISOString(),
    },
    ScanIndexForward: false, // newest first
    Limit: 100,
  }));
  
  const leads = (result.Items || []).map(lead => ({
    leadId: lead.leadId,
    timestamp: lead.timestamp,
    name: lead.name || null,
    email: lead.email || null,
    phone: lead.phone || null,
    conversationPreview: lead.conversationPreview || '',
    status: lead.status || 'new',
  }));
  
  // Summary stats
  const totalLeads = leads.length;
  const newLeads = leads.filter(l => l.status === 'new').length;
  const withEmail = leads.filter(l => l.email).length;
  const withPhone = leads.filter(l => l.phone).length;
  
  return respond(200, {
    period: `Last ${days} days`,
    totalLeads,
    newLeads,
    withEmail,
    withPhone,
    leads,
  });
}

// ───────────────────────────────────────
// LIVE CHAT: GET ALL CONVERSATIONS
// ───────────────────────────────────────
async function getClientConversations(userId) {
  if (!userId) return respond(400, { error: "userId required" });
  
  const client = await getClientByIdOrEmail(userId);
  if (!client) return respond(404, { error: "Client not found" });
  
  // Query all conversations for this client
  const result = await ddb.send(new QueryCommand({
    TableName: CONVOS_TABLE,
    KeyConditionExpression: "clientId = :cid",
    ExpressionAttributeValues: { ":cid": client.clientId },
    ScanIndexForward: false, // newest first
    Limit: 50,
  }));
  
  const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const twoMinsAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  
  const conversations = (result.Items || []).map(c => {
    // Auto-expire agent_active if no activity in 30 minutes
    let status = c.status || 'active';
    if (status === 'agent_active' && c.lastActivity && c.lastActivity < thirtyMinsAgo) {
      status = 'active'; // Expired
    }
    
    // Check if customer is still connected (heartbeat within last 2 mins)
    const customerOnline = c.lastHeartbeat && c.lastHeartbeat > twoMinsAgo;
    
    // Get the latest USER message as preview (most recent, not first)
    let preview = '';
    if (c.messages) {
      try {
        const msgs = JSON.parse(c.messages);
        // Find the last user message
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'user') {
            preview = msgs[i].content?.slice(0, 100) || '';
            break;
          }
        }
      } catch (e) {}
    }
    
    return {
      sessionId: c.sessionId,
      status: status,
      agentName: c.agentName || null,
      lastActivity: c.lastActivity,
      customerPreview: preview || c.customerPreview || '',
      messageCount: c.messages ? JSON.parse(c.messages).length : 0,
      customerOnline: customerOnline,
    };
  });
  
  // Filter to only show:
  // 1. Customer is currently online (heartbeat within 2 mins), OR
  // 2. Very recent conversation (within last 2 mins - gives time for first heartbeat)
  // Exclude closed conversations
  const twoMinsAgoCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const activeConvos = conversations.filter(c => 
    c.status !== 'closed' && (c.customerOnline || c.lastActivity > twoMinsAgoCutoff)
  );
  
  return respond(200, { conversations: activeConvos });
}

// ───────────────────────────────────────
// LIVE CHAT: GET SINGLE CONVERSATION
// ───────────────────────────────────────
async function getConversation(userId, sessionId) {
  if (!userId || !sessionId) return respond(400, { error: "userId and sessionId required" });
  
  const client = await getClientByIdOrEmail(userId);
  if (!client) return respond(404, { error: "Client not found" });
  
  const result = await ddb.send(new GetCommand({
    TableName: CONVOS_TABLE,
    Key: { clientId: client.clientId, sessionId },
  }));
  
  if (!result.Item) {
    return respond(404, { error: "Conversation not found" });
  }
  
  const convo = result.Item;
  return respond(200, {
    sessionId: convo.sessionId,
    status: convo.status || 'active',
    agentName: convo.agentName || null,
    lastActivity: convo.lastActivity,
    messages: convo.messages ? JSON.parse(convo.messages) : [],
  });
}

// ───────────────────────────────────────
// LIVE CHAT: AGENT TAKEOVER
// ───────────────────────────────────────
async function agentTakeover(userId, body) {
  if (!userId || !body.sessionId) return respond(400, { error: "userId and sessionId required" });
  
  const client = await getClientByIdOrEmail(userId);
  if (!client) return respond(404, { error: "Client not found" });
  
  const agentName = body.agentName || client.businessName || 'Support Agent';
  
  // Update conversation status
  await ddb.send(new UpdateCommand({
    TableName: CONVOS_TABLE,
    Key: { clientId: client.clientId, sessionId: body.sessionId },
    UpdateExpression: "SET #status = :status, agentName = :agent, lastActivity = :ts",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":status": "agent_active",
      ":agent": agentName,
      ":ts": new Date().toISOString(),
    },
  }));
  
  return respond(200, { success: true, agentName });
}

// ───────────────────────────────────────
// LIVE CHAT: AGENT REPLY
// ───────────────────────────────────────
async function agentReply(userId, body) {
  if (!userId || !body.sessionId || !body.message) {
    return respond(400, { error: "userId, sessionId, and message required" });
  }
  
  const client = await getClientByIdOrEmail(userId);
  if (!client) return respond(404, { error: "Client not found" });
  
  const agentName = body.agentName || client.businessName || 'Support Agent';
  
  // Get current conversation
  const result = await ddb.send(new GetCommand({
    TableName: CONVOS_TABLE,
    Key: { clientId: client.clientId, sessionId: body.sessionId },
  }));
  
  if (!result.Item) {
    return respond(404, { error: "Conversation not found" });
  }
  
  const messages = result.Item.messages ? JSON.parse(result.Item.messages) : [];
  messages.push({
    role: 'agent',
    name: agentName,
    content: body.message,
    timestamp: new Date().toISOString(),
    delivered: false,  // Mark as not delivered to widget yet
  });
  
  // Update conversation - also clear typing indicator
  await ddb.send(new UpdateCommand({
    TableName: CONVOS_TABLE,
    Key: { clientId: client.clientId, sessionId: body.sessionId },
    UpdateExpression: "SET messages = :msgs, #status = :status, agentName = :agent, lastActivity = :ts REMOVE agentTyping, agentTypingName",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":msgs": JSON.stringify(messages),
      ":status": "agent_active",
      ":agent": agentName,
      ":ts": new Date().toISOString(),
    },
  }));
  
  return respond(200, { success: true, messageCount: messages.length });
}

// ───────────────────────────────────────
// LIVE CHAT: RELEASE BACK TO AI
// ───────────────────────────────────────
async function agentRelease(userId, body) {
  if (!userId || !body.sessionId) return respond(400, { error: "userId and sessionId required" });
  
  const client = await getClientByIdOrEmail(userId);
  if (!client) return respond(404, { error: "Client not found" });
  
  // Update conversation status back to active (AI mode), clear agent flags
  await ddb.send(new UpdateCommand({
    TableName: CONVOS_TABLE,
    Key: { clientId: client.clientId, sessionId: body.sessionId },
    UpdateExpression: "SET #status = :status, lastActivity = :ts REMOVE agentName, agentJoinedNotified",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":status": "active",
      ":ts": new Date().toISOString(),
    },
  }));
  
  return respond(200, { success: true });
}

// ───────────────────────────────────────
// LIVE CHAT: AGENT END CONVERSATION
// ───────────────────────────────────────
async function agentEndConversation(userId, body) {
  if (!userId || !body.sessionId) return respond(400, { error: "userId and sessionId required" });
  
  const client = await getClientByIdOrEmail(userId);
  if (!client) return respond(404, { error: "Client not found" });
  
  // Mark conversation as closed
  await ddb.send(new UpdateCommand({
    TableName: CONVOS_TABLE,
    Key: { clientId: client.clientId, sessionId: body.sessionId },
    UpdateExpression: "SET #status = :status, closedAt = :ts REMOVE agentName, agentTyping, agentTypingName, agentJoinedNotified",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":status": "closed",
      ":ts": new Date().toISOString(),
    },
  }));
  
  return respond(200, { success: true });
}

// ───────────────────────────────────────
// LIVE CHAT: AGENT TYPING INDICATOR
// ───────────────────────────────────────
async function agentTyping(userId, body) {
  if (!userId || !body.sessionId) return respond(400, { error: "userId and sessionId required" });
  
  const client = await getClientByIdOrEmail(userId);
  if (!client) return respond(404, { error: "Client not found" });
  
  // Set typing indicator with expiration (5 seconds from now)
  const typingExpires = Date.now() + 5000;
  
  await ddb.send(new UpdateCommand({
    TableName: CONVOS_TABLE,
    Key: { clientId: client.clientId, sessionId: body.sessionId },
    UpdateExpression: "SET agentTyping = :typing, agentTypingName = :name",
    ExpressionAttributeValues: {
      ":typing": typingExpires,
      ":name": body.agentName || "Support",
    },
  }));
  
  return respond(200, { success: true });
}

// ───────────────────────────────────────
// CLIENT: IMPORT URL CONTENT
// ───────────────────────────────────────
async function importUrlContent(url) {
  if (!url) return respond(400, { error: "URL required" });
  
  // Validate URL
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Invalid protocol');
    }
    // SSRF protection: block private/internal IPs
    if (isPrivateIp(parsedUrl.hostname)) {
      return respond(400, { error: "Cannot fetch internal/private URLs" });
    }
  } catch {
    return respond(400, { error: "Invalid URL" });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
    
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'HSS-Chatbot-Trainer/1.0',
        'Accept': 'text/html,text/plain,*/*',
      },
      redirect: 'manual', // Don't follow redirects to internal IPs
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      return respond(400, { error: `Failed to fetch: HTTP ${resp.status}` });
    }

    const html = await resp.text();
    
    // Extract text content from HTML
    let content = html
      // Remove script and style blocks
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      // Remove HTML comments
      .replace(/<!--[\s\S]*?-->/g, '')
      // Remove common non-content elements
      .replace(/<(nav|header|footer|aside|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '')
      // Convert block elements to newlines
      .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n')
      .replace(/<(br|hr)[^>]*\/?>/gi, '\n')
      // Remove remaining HTML tags
      .replace(/<[^>]+>/g, ' ')
      // Decode HTML entities
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&[a-z]+;/gi, '')
      // Clean up whitespace
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n/g, '\n\n')
      .trim();

    // Limit content length (prevent massive pages)
    if (content.length > 50000) {
      content = content.substring(0, 50000) + '\n\n[Content truncated - page too large]';
    }

    if (!content || content.length < 50) {
      return respond(400, { error: "No usable content found on page" });
    }

    return respond(200, { 
      content,
      url: parsedUrl.href,
      length: content.length,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      return respond(400, { error: "Request timed out" });
    }
    console.error('Import URL error:', err);
    return respond(500, { error: "Failed to fetch page: " + err.message });
  }
}

// ───────────────────────────────────────
// CLIENT: IMPORT SITEMAP
// ───────────────────────────────────────
async function importSitemap(url) {
  if (!url) return respond(400, { error: "Sitemap URL required" });
  
  // Validate URL
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Invalid protocol');
    }
    // SSRF protection
    if (isPrivateIp(parsedUrl.hostname)) {
      return respond(400, { error: "Cannot fetch internal/private URLs" });
    }
  } catch {
    return respond(400, { error: "Invalid URL" });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout
    
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'HSS-Chatbot-Trainer/1.0',
        'Accept': 'application/xml,text/xml,*/*',
      },
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      return respond(400, { error: `Failed to fetch sitemap: HTTP ${resp.status}` });
    }

    const xml = await resp.text();
    
    // Check if this is a sitemap index (contains other sitemaps)
    const sitemapIndexMatches = xml.match(/<sitemap>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/sitemap>/gi);
    
    let urls = [];
    
    if (sitemapIndexMatches && sitemapIndexMatches.length > 0) {
      // This is a sitemap index - extract child sitemap URLs and fetch them
      for (const match of sitemapIndexMatches.slice(0, 5)) { // Limit to 5 child sitemaps
        const locMatch = match.match(/<loc>([^<]+)<\/loc>/i);
        if (locMatch) {
          try {
            const childResp = await fetch(locMatch[1], {
              headers: { 'User-Agent': 'HSS-Chatbot-Trainer/1.0' },
            });
            if (childResp.ok) {
              const childXml = await childResp.text();
              const childUrls = extractUrlsFromSitemap(childXml);
              urls.push(...childUrls);
            }
          } catch {
            // Skip failed child sitemaps
          }
        }
      }
    } else {
      // Regular sitemap - extract URLs directly
      urls = extractUrlsFromSitemap(xml);
    }

    // Filter out non-page URLs (images, videos, etc.)
    urls = urls.filter(u => {
      const lower = u.toLowerCase();
      return !lower.match(/\.(jpg|jpeg|png|gif|svg|webp|ico|pdf|mp4|mp3|zip|css|js)$/);
    });

    // Limit to 50 pages max
    if (urls.length > 50) {
      urls = urls.slice(0, 50);
    }

    if (urls.length === 0) {
      return respond(400, { error: "No page URLs found in sitemap" });
    }

    return respond(200, { 
      urls,
      count: urls.length,
      source: parsedUrl.href,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      return respond(400, { error: "Request timed out" });
    }
    console.error('Import sitemap error:', err);
    return respond(500, { error: "Failed to fetch sitemap: " + err.message });
  }
}

function extractUrlsFromSitemap(xml) {
  const urls = [];
  const locMatches = xml.match(/<url>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/url>/gi) || [];
  
  for (const match of locMatches) {
    const locMatch = match.match(/<loc>([^<]+)<\/loc>/i);
    if (locMatch && locMatch[1]) {
      urls.push(locMatch[1].trim());
    }
  }
  
  return urls;
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
// WIDGET: POLL FOR AGENT MESSAGES
// ───────────────────────────────────────
async function widgetAgentPoll(configId, sessionId) {
  if (!configId || !sessionId) {
    return respond(400, { error: "configId and sessionId required" });
  }
  
  // Get clientId from config
  const configResult = await ddb.send(new GetCommand({
    TableName: CONFIGS_TABLE,
    Key: { configId },
  }));
  
  if (!configResult.Item?.clientId) {
    return respond(404, { error: "Config not found" });
  }
  
  const clientId = configResult.Item.clientId;
  
  // Get conversation
  const convoResult = await ddb.send(new GetCommand({
    TableName: CONVOS_TABLE,
    Key: { clientId, sessionId },
  }));
  
  if (!convoResult.Item) {
    return respond(200, { agentActive: false, messages: [] });
  }
  
  const convo = convoResult.Item;
  const messages = convo.messages ? JSON.parse(convo.messages) : [];
  
  // Check if agent is currently typing (typing expires after 5 seconds)
  const isTyping = convo.agentTyping && convo.agentTyping > Date.now();
  const typingName = isTyping ? (convo.agentTypingName || convo.agentName || 'Support') : null;
  
  // Filter to only agent messages not yet delivered
  const agentMessages = messages
    .filter(m => m.role === 'agent' && !m.delivered)
    .map(m => ({ 
      role: 'agent',
      name: m.name || convo.agentName || 'Support',
      content: m.content,
      timestamp: m.timestamp 
    }));
  
  // Mark messages as delivered
  if (agentMessages.length > 0) {
    const updatedMessages = messages.map(m => {
      if (m.role === 'agent' && !m.delivered) {
        return { ...m, delivered: true };
      }
      return m;
    });
    
    await ddb.send(new UpdateCommand({
      TableName: CONVOS_TABLE,
      Key: { clientId, sessionId },
      UpdateExpression: "SET messages = :msgs",
      ExpressionAttributeValues: { ":msgs": JSON.stringify(updatedMessages) },
    }));
  }
  
  return respond(200, {
    agentActive: convo.status === 'agent_active',
    agentName: convo.agentName || null,
    agentTyping: isTyping,
    agentTypingName: typingName,
    messages: agentMessages,
  });
}

// ───────────────────────────────────────
// WIDGET: CLOSE CHAT SESSION
// ───────────────────────────────────────
async function widgetChatClose(configId, sessionId) {
  if (!configId || !sessionId) {
    return respond(400, { error: "configId and sessionId required" });
  }
  
  // Get clientId from config
  const configResult = await ddb.send(new GetCommand({
    TableName: CONFIGS_TABLE,
    Key: { configId },
  }));
  
  if (!configResult.Item?.clientId) {
    return respond(404, { error: "Config not found" });
  }
  
  const clientId = configResult.Item.clientId;
  
  // Update conversation status to closed
  try {
    await ddb.send(new UpdateCommand({
      TableName: CONVOS_TABLE,
      Key: { clientId, sessionId },
      UpdateExpression: "SET #status = :status, closedAt = :ts REMOVE agentName, agentTyping, agentTypingName, agentJoinedNotified",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "closed",
        ":ts": new Date().toISOString(),
      },
    }));
  } catch (err) {
    console.warn('Close conversation error:', err.message);
  }
  
  return respond(200, { success: true });
}

// ───────────────────────────────────────
// WIDGET: HEARTBEAT (customer still connected)
// ───────────────────────────────────────
async function widgetHeartbeat(configId, sessionId) {
  if (!configId || !sessionId) {
    return respond(400, { error: "configId and sessionId required" });
  }
  
  // Get clientId from config
  const configResult = await ddb.send(new GetCommand({
    TableName: CONFIGS_TABLE,
    Key: { configId },
  }));
  
  if (!configResult.Item?.clientId) {
    return respond(404, { error: "Config not found" });
  }
  
  const clientId = configResult.Item.clientId;
  
  // Update last heartbeat timestamp
  try {
    await ddb.send(new UpdateCommand({
      TableName: CONVOS_TABLE,
      Key: { clientId, sessionId },
      UpdateExpression: "SET lastHeartbeat = :ts",
      ExpressionAttributeValues: {
        ":ts": new Date().toISOString(),
      },
    }));
  } catch (err) {
    console.warn('Heartbeat update error:', err.message);
  }
  
  return respond(200, { success: true });
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

  // Get current client data before update (for email notification checks)
  const currentClient = await getClientByIdOrEmail(data.clientId);
  const isNewComp = data.compedPlan && data.compedUntil && 
    (!currentClient?.compedPlan || currentClient.compedUntil !== data.compedUntil);

  const updates = [];
  const names = {};
  const values = {};
  const removes = [];

  const allowed = ["plan", "status", "businessName", "website", "industry", "phone", "subscriptionStatus", "compedPlan", "compedUntil"];
  let idx = 0;
  for (const key of allowed) {
    if (data[key] !== undefined) {
      if (data[key] === null || data[key] === '') {
        // Remove empty/null fields
        const rAlias = `#r${idx}`;
        removes.push(rAlias);
        names[rAlias] = key;
      } else {
        const alias = `#a${idx}`;
        const valAlias = `:v${idx}`;
        updates.push(`${alias} = ${valAlias}`);
        names[alias] = key;
        values[valAlias] = data[key];
      }
      idx++;
    }
  }

  let updateExpr = '';
  if (updates.length > 0) updateExpr += 'SET ' + updates.join(', ');
  if (removes.length > 0) updateExpr += ' REMOVE ' + removes.join(', ');

  if (!updateExpr) return respond(400, { error: "Nothing to update" });

  await ddb.send(new UpdateCommand({
    TableName: CLIENTS_TABLE,
    Key: { clientId: data.clientId },
    UpdateExpression: updateExpr,
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
  }));

  // Send email notification for new comp (if user has notifications enabled)
  if (isNewComp && currentClient?.email && currentClient.emailNotifications !== false) {
    try {
      const compEndDate = new Date(data.compedUntil).toLocaleDateString('en-US', { 
        year: 'numeric', month: 'long', day: 'numeric' 
      });
      await ses.send(new SendEmailCommand({
        Source: `Heinrichs Software Solutions <${FROM_EMAIL}>`,
        Destination: { ToAddresses: [currentClient.email] },
        Message: {
          Subject: { Data: `🎉 You've Been Granted Complimentary ${data.compedPlan.toUpperCase()} Access!` },
          Body: {
            Text: {
              Data: `Hi${currentClient.businessName ? ` ${currentClient.businessName}` : ''},\n\nGreat news! You've been granted complimentary ${data.compedPlan.toUpperCase()} plan access until ${compEndDate}.\n\nThis includes all the features of our ${data.compedPlan} plan at no cost. Your chatbot is fully active and ready to use.\n\nManage your chatbot: ${SITE_URL}/dashboard.html\n\nQuestions? Just reply to this email.\n\nHSS Team\nHeinrichs Software Solutions Company\n\n---\nDon't want these emails? Unsubscribe: ${SITE_URL}/unsubscribe.html?id=${data.clientId}`,
            },
          },
        },
      }));
    } catch (emailErr) { console.warn("Comp notification email failed:", emailErr.message); }
  }

  return respond(200, { message: "Client updated" });
}

// ───────────────────────────────────────
// ADMIN: UPDATE TRIAL
// ───────────────────────────────────────
async function adminUpdateTrial(data) {
  if (!data.trialId) return respond(400, { error: "trialId required" });

  // Get current trial data to check for extension
  const currentTrialRes = await ddb.send(new GetCommand({
    TableName: TRIALS_TABLE,
    Key: { trialId: data.trialId },
  }));
  const currentTrial = currentTrialRes.Item;
  const isExtension = data.expiresDate && currentTrial?.expiresDate !== data.expiresDate;

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

  // Send email notification for trial extension (if user has notifications enabled)
  if (isExtension && currentTrial?.email) {
    // Get client to check emailNotifications preference
    const clientRes = await ddb.send(new ScanCommand({
      TableName: CLIENTS_TABLE,
      FilterExpression: "trialId = :tid",
      ExpressionAttributeValues: { ":tid": data.trialId },
    }));
    const client = clientRes.Items?.[0];
    
    if (client?.emailNotifications !== false) {
      try {
        const newEndDate = new Date(data.expiresDate).toLocaleDateString('en-US', { 
          year: 'numeric', month: 'long', day: 'numeric' 
        });
        const daysLeft = Math.ceil((new Date(data.expiresDate) - new Date()) / (1000 * 60 * 60 * 24));
        await ses.send(new SendEmailCommand({
          Source: `Heinrichs Software Solutions <${FROM_EMAIL}>`,
          Destination: { ToAddresses: [currentTrial.email] },
          Message: {
            Subject: { Data: `🎉 Your Trial Has Been Extended!` },
            Body: {
              Text: {
                Data: `Hi${currentTrial.businessName ? ` ${currentTrial.businessName}` : ''},\n\nGood news! Your AI chatbot trial has been extended.\n\nNew expiration date: ${newEndDate} (${daysLeft} days remaining)\n\nYour chatbot is active and ready to use. Keep testing it out!\n\nManage your chatbot: ${SITE_URL}/dashboard.html\n\nQuestions? Just reply to this email.\n\nHSS Team\nHeinrichs Software Solutions Company\n\n---\nDon't want these emails? Unsubscribe: ${SITE_URL}/unsubscribe.html?id=${client?.clientId || ''}`,
              },
            },
          },
        }));
      } catch (emailErr) { console.warn("Extension notification email failed:", emailErr.message); }
    }
  }

  return respond(200, { message: "Trial updated" });
}

// ───────────────────────────────────────
// ADMIN: UPDATE CHATBOT CONFIG
// ───────────────────────────────────────
async function adminUpdateConfig(data) {
  if (!data.configId) return respond(400, { error: "configId required" });

  // businessInfo is the friendly name for systemPrompt
  if (data.businessInfo !== undefined) data.systemPrompt = data.businessInfo;

  const updates = [];
  const names = {};
  const values = {};

  const allowed = ["systemPrompt", "brandColor", "headerColor", "headerText", "welcomeMessage", "active", "plan", "personality", "position", "discordWebhook", "allowedDomains"];
  let idx = 0;
  for (const key of allowed) {
    if (data[key] !== undefined) {
      const nameAlias = `#f${idx}`;
      const valAlias = `:v${idx}`;
      idx++;
      updates.push(`${nameAlias} = ${valAlias}`);
      names[nameAlias] = key;
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
// ADMIN: GET CHATBOT CONFIG FOR A CLIENT
// ───────────────────────────────────────
async function adminGetConfig(data) {
  if (!data.clientId) return respond(400, { error: "clientId required" });

  const clientResult = await ddb.send(new GetCommand({
    TableName: CLIENTS_TABLE,
    Key: { clientId: data.clientId },
  }));

  const client = clientResult.Item;
  if (!client || !client.configId) return respond(404, { error: "No chatbot config found" });

  const configResult = await ddb.send(new GetCommand({
    TableName: CONFIGS_TABLE,
    Key: { configId: client.configId },
  }));

  return respond(200, configResult.Item || {});
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

      // Check if client has active comp - comp supersedes trial
      const client = await ddb.send(new ScanCommand({
        TableName: CLIENTS_TABLE,
        FilterExpression: "trialId = :tid",
        ExpressionAttributeValues: { ":tid": trial.trialId },
      }));
      const clientData = client.Items?.[0];
      const hasActiveComp = clientData?.compedPlan && clientData?.compedUntil && new Date(clientData.compedUntil) > now;

      // Only deactivate chatbot if they DON'T have an active comp
      if (clientData?.configId && !hasActiveComp) {
        await ddb.send(new UpdateCommand({
          TableName: CONFIGS_TABLE,
          Key: { configId: clientData.configId },
          UpdateExpression: "SET active = :false",
          ExpressionAttributeValues: { ":false": false },
        }));

        // Email customer (only if no active comp)
        try {
          await ses.send(new SendEmailCommand({
            Source: `Heinrichs Software Solutions <${FROM_EMAIL}>`,
            Destination: { ToAddresses: [trial.email] },
            Message: {
              Subject: { Data: `Your AI Chatbot Trial Has Ended — ${trial.businessName}` },
              Body: {
                Text: {
                  Data: `Hi,\n\nYour 14-day free trial for ${trial.businessName}'s AI chatbot has ended.\n\nWant to keep it? Upgrade to a paid plan:\n• Standard: $499 setup + $79/month\n• Pro: $999 setup + $99/month\n\nUpgrade here: ${SITE_URL}/dashboard.html\n\nYour chatbot has been paused but all your data and training is saved. Upgrading reactivates it instantly.\n\nQuestions? Reply to this email.\n\nHSS Team\nHeinrichs Software Solutions Company`,
                },
              },
            },
          }));
        } catch (emailErr) { console.warn("Expiry email failed:", emailErr.message); }
      }

      expired++;
    } else {
      // Active trial — send onboarding sequence emails
      const daysSinceStart = Math.floor((now - new Date(trial.startDate || trial.createdAt)) / (1000 * 60 * 60 * 24));

      // Day 3 — tips email
      if (daysSinceStart >= 3 && !trial.onboardingDay3Sent) {
        try {
          await ses.send(new SendEmailCommand({
            Source: `Heinrichs Software Solutions <${FROM_EMAIL}>`,
            Destination: { ToAddresses: [trial.email] },
            Message: {
              Subject: { Data: `Day 3 Tip: Get More From Your AI Chatbot — ${trial.businessName}` },
              Body: {
                Text: {
                  Data: `Hi,\n\nYou're 3 days into your free chatbot trial for ${trial.businessName}. Here are a few tips:\n\n1. Update your business info — log in to your dashboard and refine your chatbot's training. The more detail you add, the better it answers.\n   ${SITE_URL}/dashboard.html\n\n2. Share it with a colleague — ask them to test it with real customer questions.\n\n3. Check your conversations — your dashboard shows everything your chatbot has said. Use it to spot gaps.\n\nYou have ${daysLeft} days left in your trial. Reply to this email with any questions.\n\nHSS Team\nHeinrichs Software Solutions Company`,
                },
              },
            },
          }));
          await ddb.send(new UpdateCommand({
            TableName: TRIALS_TABLE,
            Key: { trialId: trial.trialId },
            UpdateExpression: "SET onboardingDay3Sent = :true",
            ExpressionAttributeValues: { ":true": true },
          }));
        } catch (emailErr) { console.warn("Day 3 email failed:", emailErr.message); }
      }

      // Day 5 — ROI nudge + upgrade CTA
      if (daysSinceStart >= 5 && !trial.onboardingDay5Sent) {
        try {
          await ses.send(new SendEmailCommand({
            Source: `Heinrichs Software Solutions <${FROM_EMAIL}>`,
            Destination: { ToAddresses: [trial.email] },
            Message: {
              Subject: { Data: `How's the chatbot working for ${trial.businessName}?` },
              Body: {
                Text: {
                  Data: `Hi,\n\nYou're 5 days into your free trial for ${trial.businessName}. We hope your chatbot has been saving you time answering customer questions.\n\nWant to keep it going? Upgrading takes less than 5 minutes:\n\n• Standard: $499 setup + $79/month — 2,500 conversations, 1 domain, email support\n• Pro: $999 setup + $99/month — 10,000 conversations, lead capture, analytics, priority support\n\nUpgrade here: ${SITE_URL}/dashboard.html\n\nOr reply to this email — we're happy to help find the right plan.\n\nHSS Team\nHeinrichs Software Solutions Company`,
                },
              },
            },
          }));
          await ddb.send(new UpdateCommand({
            TableName: TRIALS_TABLE,
            Key: { trialId: trial.trialId },
            UpdateExpression: "SET onboardingDay5Sent = :true",
            ExpressionAttributeValues: { ":true": true },
          }));
        } catch (emailErr) { console.warn("Day 5 email failed:", emailErr.message); }
      }

      // Expiring in 3 days — send warning
      if (daysLeft <= 3 && daysLeft > 0) {
      try {
        await ses.send(new SendEmailCommand({
          Source: `Heinrichs Software Solutions <${FROM_EMAIL}>`,
          Destination: { ToAddresses: [trial.email] },
          Message: {
            Subject: { Data: `⏰ Your AI Chatbot Trial Expires in ${daysLeft} Day${daysLeft === 1 ? "" : "s"}` },
            Body: {
              Text: {
                Data: `Hi,\n\nJust a heads-up: your free chatbot trial for ${trial.businessName} expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.\n\nDon't lose your AI chatbot! Upgrade to keep it running:\n${SITE_URL}/dashboard.html\n\nUpgrade options:\n• Standard: $499 setup + $79/month\n• Pro: $999 setup + $99/month\n\nYour chatbot data and training will be saved either way.\n\nHSS Team`,
              },
            },
          },
        }));
      } catch (emailErr) { console.warn("Warning email failed:", emailErr.message); }
        expiringSoon++;
      }
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
// COMP EXPIRATION CHECKER (scheduled)
// ───────────────────────────────────────
async function checkCompExpirations() {
  const now = new Date();
  
  // Scan for clients with compedPlan and compedUntil set
  const result = await ddb.send(new ScanCommand({
    TableName: CLIENTS_TABLE,
    FilterExpression: "attribute_exists(compedPlan) AND attribute_exists(compedUntil)",
  }));

  let expired = 0;
  let expiringSoon = 0;

  for (const client of result.Items || []) {
    if (!client.compedUntil || !client.compedPlan) continue;
    
    const expiresDate = new Date(client.compedUntil);
    const daysLeft = Math.ceil((expiresDate - now) / (1000 * 60 * 60 * 24));

    // Expired — deactivate config and clear comp
    if (daysLeft <= 0) {
      // Deactivate chatbot config if they don't have a paid subscription
      if (client.plan === 'trial' || client.plan === 'expired') {
        if (client.configId) {
          await ddb.send(new UpdateCommand({
            TableName: CONFIGS_TABLE,
            Key: { configId: client.configId },
            UpdateExpression: "SET active = :false",
            ExpressionAttributeValues: { ":false": false },
          }));
        }

        // Update client plan to expired
        await ddb.send(new UpdateCommand({
          TableName: CLIENTS_TABLE,
          Key: { clientId: client.clientId },
          UpdateExpression: "SET plan = :expired, compedPlan = :null, compedUntil = :null",
          ExpressionAttributeValues: { 
            ":expired": "expired",
            ":null": null
          },
        }));
      } else {
        // Paid customer — just clear the comp fields
        await ddb.send(new UpdateCommand({
          TableName: CLIENTS_TABLE,
          Key: { clientId: client.clientId },
          UpdateExpression: "REMOVE compedPlan, compedUntil",
        }));
      }

      // Email customer
      if (client.email) {
        try {
          await ses.send(new SendEmailCommand({
            Source: `Heinrichs Software Solutions <${FROM_EMAIL}>`,
            Destination: { ToAddresses: [client.email] },
            Message: {
              Subject: { Data: `Your Complimentary AI Chatbot Period Has Ended — ${client.businessName || 'Your Business'}` },
              Body: {
                Text: {
                  Data: `Hi,\n\nYour complimentary ${client.compedPlan.toUpperCase()} chatbot access for ${client.businessName || 'your business'} has ended.\n\nWant to keep your AI chatbot running? Subscribe to a paid plan:\n• Standard: $499 setup + $49/month (2,500 conversations)\n• Pro: $999 setup + $99/month (10,000 conversations)\n\nUpgrade here: ${SITE_URL}/dashboard.html\n\nYour chatbot has been paused but all your data and training is saved. Subscribing reactivates it instantly.\n\nQuestions? Reply to this email.\n\nHSS Team\nHeinrichs Software Solutions Company`,
                },
              },
            },
          }));
        } catch (emailErr) { console.warn("Comp expiry email failed:", emailErr.message); }
      }

      expired++;
    }
    // Expiring in 3 days — send warning
    else if (daysLeft <= 3 && daysLeft > 0) {
      if (client.email) {
        try {
          await ses.send(new SendEmailCommand({
            Source: `Heinrichs Software Solutions <${FROM_EMAIL}>`,
            Destination: { ToAddresses: [client.email] },
            Message: {
              Subject: { Data: `⏰ Your Complimentary Chatbot Access Expires in ${daysLeft} Day${daysLeft === 1 ? "" : "s"}` },
              Body: {
                Text: {
                  Data: `Hi,\n\nJust a heads-up: your complimentary ${client.compedPlan.toUpperCase()} chatbot access for ${client.businessName || 'your business'} expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.\n\nDon't lose your AI chatbot! Subscribe to keep it running:\n${SITE_URL}/dashboard.html\n\nYour chatbot data and training will be saved either way.\n\nHSS Team`,
                },
              },
            },
          }));
        } catch (emailErr) { console.warn("Comp warning email failed:", emailErr.message); }
      }
      expiringSoon++;
    }
  }

  // Notify admin
  if (expired > 0 || expiringSoon > 0) {
    try {
      await ses.send(new SendEmailCommand({
        Source: `HSS Comp System <${FROM_EMAIL}>`,
        Destination: { ToAddresses: [NOTIFY_EMAIL] },
        Message: {
          Subject: { Data: `Comp Check: ${expired} expired, ${expiringSoon} expiring soon` },
          Body: {
            Text: { Data: `Comp expiration check complete.\n\nExpired (deactivated): ${expired}\nExpiring in 3 days (warning sent): ${expiringSoon}\n\nDashboard: ${SITE_URL}/admin.html` },
          },
        },
      }));
    } catch (emailErr) { console.warn("Admin notification failed:", emailErr.message); }
  }

  return respond(200, { expired, expiringSoon, type: "comp" });
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

function respond(statusCode, body, origin) {
  return {
    statusCode,
    headers: getCorsHeaders(origin || ALLOWED_ORIGINS[0]),
    body: JSON.stringify(body),
  };
}
