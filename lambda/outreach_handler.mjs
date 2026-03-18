/**
 * HSS Email Outreach Agent — Lambda Handler (Node.js 20.x)
 * 
 * Sends personalized cold outreach emails to prospects via AWS SES.
 * Designed to be triggered by:
 *   - CloudWatch Events (scheduled, e.g. daily batch)
 *   - Manual invocation via AWS Console / CLI
 *   - API Gateway endpoint (POST /outreach)
 * 
 * Prospect data is stored in DynamoDB table "HSS-OUTREACH-PROSPECTS".
 * Each prospect record tracks email status to prevent duplicates.
 * 
 * Environment Variables:
 *   PROSPECTS_TABLE  - DynamoDB table name (default: HSS-OUTREACH-PROSPECTS)
 *   FROM_EMAIL       - SES-verified sender (default: contact@heinrichstech.com)
 *   DAILY_LIMIT      - Max emails per invocation (default: 25)
 *   REGION           - AWS region (default: us-east-2)
 */

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

// ─── CONFIG ───
const REGION = process.env.REGION || "us-east-2";
const FROM_EMAIL = process.env.FROM_EMAIL || "contact@heinrichstech.com";
const NOTIFY_EMAIL = "heinrichssoftwaresolutions@gmail.com";
const PROSPECTS_TABLE = process.env.PROSPECTS_TABLE || "HSS-OUTREACH-PROSPECTS";
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || "25", 10);
const SITE_URL = "https://heinrichstech.com";

const ses = new SESClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─── EMAIL TEMPLATES ───
const TEMPLATES = {
  // Template 1: General intro for any small business
  general: (prospect) => ({
    subject: `${prospect.businessName} — Free AI Chatbot Trial (No Strings Attached)`,
    body: `Hi ${prospect.contactName},

I came across ${prospect.businessName} and wanted to reach out because I think we can help you capture more leads and save time on customer questions.

We build custom AI chatbots for ${prospect.industry || "small businesses"} — the kind that answer customer questions 24/7, capture leads while you sleep, and sound like they were trained by your best employee.

Here's what makes us different:
• Free 14-day trial — no credit card, no commitment
• Custom-trained on YOUR business (not generic templates)
• Works on any website in under 24 hours
• Plans start at just $49/month after setup

We're a veteran-owned software company based in Florida, and we've built chatbots for restaurants, law firms, dental offices, contractors, and more.

Would you be open to a quick 10-minute call this week? Or if you'd rather just see it in action, I can set up a free demo on your site — takes about a day.

Try it free: ${SITE_URL}/signup.html

Best,
HSS Team
Heinrichs Software Solutions LLC
(619) 770-7306
${SITE_URL}`,
  }),

  // Template 2: Industry-specific (uses prospect.industry to customize)
  industry: (prospect) => {
    const hooks = {
      restaurant: "answering \"what are your hours?\" and \"do you take reservations?\" while your staff focuses on guests",
      dental: "handling insurance questions, new patient intake, and appointment scheduling after hours",
      legal: "capturing potential client details after hours when 40% of legal searches happen",
      "real estate": "qualifying buyers and sellers instantly so you only spend time on serious leads",
      contractor: "capturing emergency service requests and scheduling estimates while you're on a job",
      ecommerce: "recovering abandoned carts, recommending products, and handling returns automatically",
    };
    const hook = hooks[prospect.industry?.toLowerCase()] ||
      "answering repetitive questions and capturing leads around the clock";

    return {
      subject: `Quick idea for ${prospect.businessName}`,
      body: `Hi ${prospect.contactName},

I noticed ${prospect.businessName} online and had a quick idea that could help you ${hook}.

We build AI chatbots specifically for ${prospect.industry || "businesses like yours"}. Think of it as a virtual front-desk assistant that:
• Never calls in sick
• Answers in seconds (not minutes)
• Works nights, weekends, and holidays
• Costs less than $2/day

One of our ${prospect.industry || "small business"} clients saw a 3x increase in qualified leads within the first month.

We offer a completely free 14-day trial — we'll build a custom chatbot trained on ${prospect.businessName} and deploy it on your site. If you love it, great. If not, no hard feelings.

Interested? Just reply to this email or book a quick call:
${SITE_URL}/signup.html

Best,
HSS Team
Heinrichs Software Solutions LLC
(619) 770-7306`,
    };
  },

  // Template 3: Follow-up (sent to prospects who didn't respond to first email)
  followup: (prospect) => ({
    subject: `Re: Quick idea for ${prospect.businessName}`,
    body: `Hi ${prospect.contactName},

Just wanted to follow up on my note last week about adding an AI chatbot to ${prospect.businessName}'s website.

I know you're busy, so I'll keep this short: we can have a working demo live on your site in 24 hours at zero cost. If it doesn't impress you, we'll remove it — no questions asked.

Here's a quick 2-minute read on how it works for ${prospect.industry || "businesses like yours"}:
${SITE_URL}/blog.html

Worth a shot?

HSS Team
(619) 770-7306`,
  }),
};

// ─── MAIN HANDLER ───
export const handler = async (event) => {
  // Handle CORS preflight for API Gateway
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  // Determine action
  let action = "send-batch"; // default: scheduled batch
  let body = {};

  if (event.body) {
    body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    action = body.action || "send-batch";
  } else if (event.action) {
    action = event.action;
    body = event;
  }

  try {
    switch (action) {
      case "send-batch":
        return await sendBatch();
      case "add-prospect":
        return await addProspect(body.prospect);
      case "add-prospects":
        return await addProspects(body.prospects);
      case "status":
        return await getStatus();
      default:
        return respond(400, { error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error("Outreach error:", err);
    return respond(500, { error: err.message });
  }
};

// ─── SEND BATCH ───
async function sendBatch() {
  // Get unsent prospects
  const result = await ddb.send(new ScanCommand({
    TableName: PROSPECTS_TABLE,
    FilterExpression: "#s = :pending OR #s = :followup_ready",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ":pending": "pending",
      ":followup_ready": "followup_ready",
    },
  }));

  const prospects = result.Items || [];
  if (prospects.length === 0) {
    return respond(200, { message: "No pending prospects", sent: 0 });
  }

  // Sort: follow-ups first (higher priority), then pending
  prospects.sort((a, b) => {
    if (a.status === "followup_ready" && b.status !== "followup_ready") return -1;
    if (b.status === "followup_ready" && a.status !== "followup_ready") return 1;
    return 0;
  });

  const batch = prospects.slice(0, DAILY_LIMIT);
  let sent = 0;
  let errors = [];

  for (const prospect of batch) {
    try {
      // Determine template
      let template;
      if (prospect.status === "followup_ready") {
        template = TEMPLATES.followup(prospect);
      } else if (prospect.industry && TEMPLATES.industry) {
        template = TEMPLATES.industry(prospect);
      } else {
        template = TEMPLATES.general(prospect);
      }

      // Send email
      await ses.send(new SendEmailCommand({
        Source: `Heinrichs Software Solutions <${FROM_EMAIL}>`,
        Destination: { ToAddresses: [prospect.email] },
        Message: {
          Subject: { Data: template.subject },
          Body: { Text: { Data: template.body } },
        },
      }));

      // Update prospect status
      const newStatus = prospect.status === "followup_ready" ? "followup_sent" : "initial_sent";
      const now = new Date().toISOString();

      await ddb.send(new UpdateCommand({
        TableName: PROSPECTS_TABLE,
        Key: { email: prospect.email },
        UpdateExpression: "SET #s = :status, lastEmailDate = :date, emailCount = if_not_exists(emailCount, :zero) + :one",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":status": newStatus,
          ":date": now,
          ":zero": 0,
          ":one": 1,
        },
      }));

      sent++;
      console.log(`✓ Sent to ${prospect.email} (${newStatus})`);
    } catch (err) {
      console.error(`✗ Failed for ${prospect.email}:`, err.message);
      errors.push({ email: prospect.email, error: err.message });
    }
  }

  // Send summary to owner
  if (sent > 0) {
    await ses.send(new SendEmailCommand({
      Source: `HSS Outreach Agent <${FROM_EMAIL}>`,
      Destination: { ToAddresses: [NOTIFY_EMAIL] },
      Message: {
        Subject: { Data: `Outreach Report: ${sent} emails sent` },
        Body: {
          Text: {
            Data: `Outreach batch complete.\n\nSent: ${sent}\nErrors: ${errors.length}\nRemaining prospects: ${prospects.length - batch.length}\n\n${errors.length > 0 ? "Errors:\n" + errors.map(e => `  ${e.email}: ${e.error}`).join("\n") : "No errors."}`,
          },
        },
      },
    }));
  }

  return respond(200, {
    message: `Batch complete`,
    sent,
    errors: errors.length,
    remaining: prospects.length - batch.length,
  });
}

// ─── ADD SINGLE PROSPECT ───
async function addProspect(prospect) {
  if (!prospect || !prospect.email || !prospect.contactName || !prospect.businessName) {
    return respond(400, {
      error: "Required fields: email, contactName, businessName",
    });
  }

  await ddb.send(new PutCommand({
    TableName: PROSPECTS_TABLE,
    Item: {
      email: prospect.email.toLowerCase().trim(),
      contactName: prospect.contactName.trim(),
      businessName: prospect.businessName.trim(),
      industry: prospect.industry || "general",
      website: prospect.website || "",
      phone: prospect.phone || "",
      notes: prospect.notes || "",
      source: prospect.source || "manual",
      status: "pending",
      emailCount: 0,
      createdAt: new Date().toISOString(),
    },
    ConditionExpression: "attribute_not_exists(email)",
  }));

  return respond(200, { message: `Added prospect: ${prospect.email}` });
}

// ─── ADD MULTIPLE PROSPECTS (BULK) ───
async function addProspects(prospects) {
  if (!Array.isArray(prospects) || prospects.length === 0) {
    return respond(400, { error: "prospects must be a non-empty array" });
  }

  let added = 0;
  let skipped = 0;
  let errors = [];

  for (const prospect of prospects) {
    try {
      await ddb.send(new PutCommand({
        TableName: PROSPECTS_TABLE,
        Item: {
          email: prospect.email.toLowerCase().trim(),
          contactName: prospect.contactName.trim(),
          businessName: prospect.businessName.trim(),
          industry: prospect.industry || "general",
          website: prospect.website || "",
          phone: prospect.phone || "",
          notes: prospect.notes || "",
          source: prospect.source || "bulk-import",
          status: "pending",
          emailCount: 0,
          createdAt: new Date().toISOString(),
        },
        ConditionExpression: "attribute_not_exists(email)",
      }));
      added++;
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        skipped++; // Already exists
      } else {
        errors.push({ email: prospect.email, error: err.message });
      }
    }
  }

  return respond(200, {
    message: `Bulk import complete`,
    added,
    skipped,
    errors: errors.length,
  });
}

// ─── STATUS ───
async function getStatus() {
  const result = await ddb.send(new ScanCommand({
    TableName: PROSPECTS_TABLE,
    Select: "ALL_ATTRIBUTES",
  }));

  const items = result.Items || [];
  const counts = {};
  for (const item of items) {
    counts[item.status] = (counts[item.status] || 0) + 1;
  }

  return respond(200, {
    total: items.length,
    breakdown: counts,
  });
}

// ─── HELPER: SCHEDULE FOLLOW-UPS ───
// Run this as a separate scheduled event or manually to flag
// prospects who received initial email 5+ days ago but haven't responded.
export const scheduleFollowups = async () => {
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

  const result = await ddb.send(new ScanCommand({
    TableName: PROSPECTS_TABLE,
    FilterExpression: "#s = :sent AND lastEmailDate < :cutoff",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ":sent": "initial_sent",
      ":cutoff": fiveDaysAgo,
    },
  }));

  let updated = 0;
  for (const item of result.Items || []) {
    await ddb.send(new UpdateCommand({
      TableName: PROSPECTS_TABLE,
      Key: { email: item.email },
      UpdateExpression: "SET #s = :status",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":status": "followup_ready" },
    }));
    updated++;
  }

  return { message: `Flagged ${updated} prospects for follow-up` };
};

// ─── RESPONSE HELPER ───
function respond(statusCode, body) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}
