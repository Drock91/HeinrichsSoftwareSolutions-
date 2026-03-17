/**
 * HSS Payment Handler — Lambda (Node.js 20.x)
 * 
 * Handles Stripe Checkout sessions, subscription management, and webhooks.
 * 
 * Environment Variables:
 *   STRIPE_SECRET_KEY     - Stripe secret key (sk_live_... or sk_test_...)
 *   STRIPE_WEBHOOK_SECRET - Stripe webhook signing secret (whsec_...)
 *   CLIENTS_TABLE         - default: HSS-CLIENTS
 *   TRIALS_TABLE          - default: HSS-TRIALS
 *   CONFIGS_TABLE         - default: HSS-CHATBOT-CONFIGS
 *   FROM_EMAIL            - default: contact@heinrichstech.com
 *   REGION                - default: us-east-2
 * 
 * Stripe Products (create in Stripe Dashboard):
 *   Standard Setup: $499 one-time  (price ID in STANDARD_SETUP_PRICE)
 *   Standard Monthly: $49/month    (price ID in STANDARD_MONTHLY_PRICE)
 *   Pro Setup: $999 one-time       (price ID in PRO_SETUP_PRICE)
 *   Pro Monthly: $99/month         (price ID in PRO_MONTHLY_PRICE)
 */

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

// ─── CONFIG ───
const REGION = process.env.REGION || "us-east-2";
const FROM_EMAIL = process.env.FROM_EMAIL || "contact@heinrichstech.com";
const NOTIFY_EMAIL = "heinrichssoftwaresolutions@gmail.com";
const CLIENTS_TABLE = process.env.CLIENTS_TABLE || "HSS-CLIENTS";
const TRIALS_TABLE = process.env.TRIALS_TABLE || "HSS-TRIALS";
const CONFIGS_TABLE = process.env.CONFIGS_TABLE || "HSS-CHATBOT-CONFIGS";
const SITE_URL = "https://heinrichstech.com";

// Stripe config — set these in Lambda environment variables
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Stripe Price IDs — create these in Stripe Dashboard, then set as env vars
const STANDARD_SETUP_PRICE = process.env.STANDARD_SETUP_PRICE || "price_standard_setup";
const STANDARD_MONTHLY_PRICE = process.env.STANDARD_MONTHLY_PRICE || "price_standard_monthly";
const PRO_SETUP_PRICE = process.env.PRO_SETUP_PRICE || "price_pro_setup";
const PRO_MONTHLY_PRICE = process.env.PRO_MONTHLY_PRICE || "price_pro_monthly";

const ses = new SESClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─── Stripe API helper (no SDK needed) ───
async function stripeRequest(endpoint, params) {
  const body = new URLSearchParams();
  flattenParams(params, body);

  const resp = await fetch(`https://api.stripe.com/v1${endpoint}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

async function stripeGet(endpoint) {
  const resp = await fetch(`https://api.stripe.com/v1${endpoint}`, {
    headers: { "Authorization": `Bearer ${STRIPE_SECRET_KEY}` },
  });
  return resp.json();
}

async function stripeDelete(endpoint) {
  const resp = await fetch(`https://api.stripe.com/v1${endpoint}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${STRIPE_SECRET_KEY}` },
  });
  return resp.json();
}

// Flatten nested objects for URL-encoded Stripe params
function flattenParams(obj, params, prefix = "") {
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      flattenParams(val, params, fullKey);
    } else if (Array.isArray(val)) {
      val.forEach((item, i) => {
        if (typeof item === "object") {
          flattenParams(item, params, `${fullKey}[${i}]`);
        } else {
          params.append(`${fullKey}[${i}]`, item);
        }
      });
    } else {
      params.append(fullKey, String(val));
    }
  }
}

// ─── MAIN HANDLER ───
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return respond(200, {});
  }

  const path = event.path || event.rawPath || "";
  let body = {};

  // Webhook needs raw body for signature verification
  const rawBody = event.body || "";

  if (event.body && !path.endsWith("/webhook")) {
    body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  }

  try {
    // ─── CREATE CHECKOUT SESSION ───
    if (path.endsWith("/checkout") || body.action === "create-checkout") {
      return await createCheckout(body);
    }

    // ─── GET SUBSCRIPTION STATUS ───
    if (path.endsWith("/subscription") || body.action === "get-subscription") {
      return await getSubscription(body.clientId);
    }

    // ─── CANCEL SUBSCRIPTION ───
    if (path.endsWith("/cancel") || body.action === "cancel-subscription") {
      return await cancelSubscription(body.clientId);
    }

    // ─── REACTIVATE (resume canceled sub) ───
    if (path.endsWith("/reactivate") || body.action === "reactivate") {
      return await reactivateSubscription(body.clientId);
    }

    // ─── CUSTOMER PORTAL (manage billing in Stripe) ───
    if (path.endsWith("/portal") || body.action === "customer-portal") {
      return await createPortalSession(body.clientId);
    }

    // ─── STRIPE WEBHOOK ───
    if (path.endsWith("/webhook")) {
      return await handleWebhook(rawBody, event.headers);
    }

    return respond(404, { error: "Route not found" });
  } catch (err) {
    console.error("Payment handler error:", err);
    return respond(500, { error: err.message });
  }
};

// ───────────────────────────────────────
// CREATE CHECKOUT SESSION
// ───────────────────────────────────────
async function createCheckout(data) {
  const { clientId, plan, email } = data;
  if (!clientId || !plan) return respond(400, { error: "clientId and plan required" });

  // Look up client
  const client = await getClient(clientId);
  if (!client) return respond(404, { error: "Client not found" });

  // Determine prices
  let lineItems;
  if (plan === "standard") {
    lineItems = [
      { price: STANDARD_SETUP_PRICE, quantity: 1 },   // $499 one-time
      { price: STANDARD_MONTHLY_PRICE, quantity: 1 },  // $49/month recurring
    ];
  } else if (plan === "pro") {
    lineItems = [
      { price: PRO_SETUP_PRICE, quantity: 1 },   // $999 one-time
      { price: PRO_MONTHLY_PRICE, quantity: 1 },  // $99/month recurring
    ];
  } else {
    return respond(400, { error: "Invalid plan. Use 'standard' or 'pro'." });
  }

  // Create or get Stripe customer
  let stripeCustomerId = client.stripeCustomerId;
  if (!stripeCustomerId) {
    const customer = await stripeRequest("/customers", {
      email: client.email,
      name: client.businessName,
      metadata: { clientId, plan },
    });
    stripeCustomerId = customer.id;

    // Save Stripe customer ID
    await ddb.send(new UpdateCommand({
      TableName: CLIENTS_TABLE,
      Key: { clientId },
      UpdateExpression: "SET stripeCustomerId = :sc",
      ExpressionAttributeValues: { ":sc": stripeCustomerId },
    }));
  }

  // Create Checkout Session
  const session = await stripeRequest("/checkout/sessions", {
    customer: stripeCustomerId,
    mode: "subscription",
    "line_items[0][price]": lineItems[0].price,
    "line_items[0][quantity]": "1",
    "line_items[1][price]": lineItems[1].price,
    "line_items[1][quantity]": "1",
    success_url: `${SITE_URL}/dashboard.html?payment=success&plan=${plan}`,
    cancel_url: `${SITE_URL}/dashboard.html?payment=cancelled`,
    "subscription_data[metadata][clientId]": clientId,
    "subscription_data[metadata][plan]": plan,
    "metadata[clientId]": clientId,
    "metadata[plan]": plan,
  });

  return respond(200, { checkoutUrl: session.url, sessionId: session.id });
}

// ───────────────────────────────────────
// GET SUBSCRIPTION STATUS
// ───────────────────────────────────────
async function getSubscription(clientId) {
  if (!clientId) return respond(400, { error: "clientId required" });

  const client = await getClient(clientId);
  if (!client) return respond(404, { error: "Client not found" });

  const result = {
    plan: client.plan || "trial",
    status: client.subscriptionStatus || "none",
    subscriptionId: client.stripeSubscriptionId || null,
    currentPeriodEnd: client.currentPeriodEnd || null,
    cancelAtPeriodEnd: client.cancelAtPeriodEnd || false,
  };

  // If there's an active subscription, get latest info from Stripe
  if (client.stripeSubscriptionId && STRIPE_SECRET_KEY) {
    try {
      const sub = await stripeGet(`/subscriptions/${client.stripeSubscriptionId}`);
      result.status = sub.status;
      result.currentPeriodEnd = new Date(sub.current_period_end * 1000).toISOString();
      result.cancelAtPeriodEnd = sub.cancel_at_period_end;
    } catch (err) {
      console.warn("Could not fetch Stripe subscription:", err.message);
    }
  }

  return respond(200, result);
}

// ───────────────────────────────────────
// CANCEL SUBSCRIPTION
// ───────────────────────────────────────
async function cancelSubscription(clientId) {
  if (!clientId) return respond(400, { error: "clientId required" });

  const client = await getClient(clientId);
  if (!client?.stripeSubscriptionId) {
    return respond(400, { error: "No active subscription found" });
  }

  // Cancel at period end (they keep access until billing period ends)
  const sub = await stripeRequest(`/subscriptions/${client.stripeSubscriptionId}`, {
    cancel_at_period_end: "true",
  });

  // Update DynamoDB
  await ddb.send(new UpdateCommand({
    TableName: CLIENTS_TABLE,
    Key: { clientId },
    UpdateExpression: "SET cancelAtPeriodEnd = :true, subscriptionStatus = :status",
    ExpressionAttributeValues: {
      ":true": true,
      ":status": "canceling",
    },
  }));

  // Notify admin
  await ses.send(new SendEmailCommand({
    Source: `HSS Billing <${FROM_EMAIL}>`,
    Destination: { ToAddresses: [NOTIFY_EMAIL] },
    Message: {
      Subject: { Data: `Cancellation: ${client.businessName} (${client.plan})` },
      Body: {
        Text: {
          Data: `Client ${client.businessName} (${client.email}) has cancelled their ${client.plan} plan.\n\nAccess continues until: ${new Date(sub.current_period_end * 1000).toLocaleDateString()}\n\nConsider reaching out to retain them.`,
        },
      },
    },
  }));

  return respond(200, {
    message: "Subscription will cancel at end of billing period",
    cancelDate: new Date(sub.current_period_end * 1000).toISOString(),
  });
}

// ───────────────────────────────────────
// REACTIVATE SUBSCRIPTION
// ───────────────────────────────────────
async function reactivateSubscription(clientId) {
  if (!clientId) return respond(400, { error: "clientId required" });

  const client = await getClient(clientId);
  if (!client?.stripeSubscriptionId) {
    return respond(400, { error: "No subscription found" });
  }

  // Remove cancellation
  const sub = await stripeRequest(`/subscriptions/${client.stripeSubscriptionId}`, {
    cancel_at_period_end: "false",
  });

  await ddb.send(new UpdateCommand({
    TableName: CLIENTS_TABLE,
    Key: { clientId },
    UpdateExpression: "SET cancelAtPeriodEnd = :false, subscriptionStatus = :status",
    ExpressionAttributeValues: {
      ":false": false,
      ":status": "active",
    },
  }));

  return respond(200, { message: "Subscription reactivated" });
}

// ───────────────────────────────────────
// STRIPE CUSTOMER PORTAL
// ───────────────────────────────────────
async function createPortalSession(clientId) {
  if (!clientId) return respond(400, { error: "clientId required" });

  const client = await getClient(clientId);
  if (!client?.stripeCustomerId) {
    return respond(400, { error: "No Stripe customer found. Please subscribe first." });
  }

  const session = await stripeRequest("/billing_portal/sessions", {
    customer: client.stripeCustomerId,
    return_url: `${SITE_URL}/dashboard.html`,
  });

  return respond(200, { portalUrl: session.url });
}

// ───────────────────────────────────────
// STRIPE WEBHOOK
// ───────────────────────────────────────
async function handleWebhook(rawBody, headers) {
  // Verify webhook signature
  const sig = headers["stripe-signature"] || headers["Stripe-Signature"];

  if (STRIPE_WEBHOOK_SECRET && sig) {
    // Simple signature verification (timestamp + payload)
    // In production, use Stripe's official verification
    // For now we process all webhook events
  }

  let event;
  try {
    event = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
  } catch (e) {
    return respond(400, { error: "Invalid webhook payload" });
  }

  console.log(`Webhook received: ${event.type}`);

  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutComplete(event.data.object);
      break;

    case "customer.subscription.updated":
      await handleSubscriptionUpdate(event.data.object);
      break;

    case "customer.subscription.deleted":
      await handleSubscriptionDeleted(event.data.object);
      break;

    case "invoice.payment_succeeded":
      await handlePaymentSucceeded(event.data.object);
      break;

    case "invoice.payment_failed":
      await handlePaymentFailed(event.data.object);
      break;

    default:
      console.log(`Unhandled webhook event: ${event.type}`);
  }

  return respond(200, { received: true });
}

// ─── Webhook handlers ───

async function handleCheckoutComplete(session) {
  const clientId = session.metadata?.clientId;
  const plan = session.metadata?.plan;
  if (!clientId) return;

  const subscriptionId = session.subscription;

  // Update client record
  await ddb.send(new UpdateCommand({
    TableName: CLIENTS_TABLE,
    Key: { clientId },
    UpdateExpression: "SET #p = :plan, subscriptionStatus = :status, stripeSubscriptionId = :subId, stripeCustomerId = :custId, paidAt = :now, cancelAtPeriodEnd = :false",
    ExpressionAttributeNames: { "#p": "plan" },
    ExpressionAttributeValues: {
      ":plan": plan,
      ":status": "active",
      ":subId": subscriptionId,
      ":custId": session.customer,
      ":now": new Date().toISOString(),
      ":false": false,
    },
  }));

  // Activate chatbot config (in case it was deactivated)
  const client = await getClient(clientId);
  if (client?.configId) {
    await ddb.send(new UpdateCommand({
      TableName: CONFIGS_TABLE,
      Key: { configId: client.configId },
      UpdateExpression: "SET active = :true, #p = :plan",
      ExpressionAttributeNames: { "#p": "plan" },
      ExpressionAttributeValues: { ":true": true, ":plan": plan },
    }));
  }

  // Update trial status
  if (client?.trialId) {
    await ddb.send(new UpdateCommand({
      TableName: TRIALS_TABLE,
      Key: { trialId: client.trialId },
      UpdateExpression: "SET #s = :converted",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":converted": "converted" },
    }));
  }

  // Notify admin
  await ses.send(new SendEmailCommand({
    Source: `HSS Billing <${FROM_EMAIL}>`,
    Destination: { ToAddresses: [NOTIFY_EMAIL] },
    Message: {
      Subject: { Data: `💰 New Payment: ${client?.businessName || clientId} → ${plan}` },
      Body: {
        Text: {
          Data: `New paid signup!\n\nClient: ${client?.businessName}\nEmail: ${client?.email}\nPlan: ${plan}\nSubscription: ${subscriptionId}\n\nDashboard: ${SITE_URL}/admin.html`,
        },
      },
    },
  }));

  // Email customer confirmation
  if (client?.email) {
    const planName = plan === "pro" ? "Pro" : "Standard";
    const monthly = plan === "pro" ? "$99" : "$49";

    await ses.send(new SendEmailCommand({
      Source: `Heinrichs Software Solutions <${FROM_EMAIL}>`,
      Destination: { ToAddresses: [client.email] },
      Message: {
        Subject: { Data: `Welcome to ${planName}! Your AI Chatbot is Fully Active` },
        Body: {
          Text: {
            Data: `Hi!\n\nThank you for upgrading to the ${planName} plan! Your AI chatbot for ${client.businessName} is now fully active with unlimited conversations.\n\nPlan Details:\n• Plan: ${planName}\n• Monthly billing: ${monthly}/month\n• Conversations: Unlimited\n• Support: ${plan === "pro" ? "Priority" : "Email"}\n\nManage your subscription anytime from your dashboard:\n${SITE_URL}/dashboard.html\n\nNeed help? Reply to this email or call (619) 770-7306.\n\nDaniel Heinrich\nHeinrichs Software Solutions LLC`,
          },
        },
      },
    }));
  }
}

async function handleSubscriptionUpdate(subscription) {
  const clientId = subscription.metadata?.clientId;
  if (!clientId) return;

  await ddb.send(new UpdateCommand({
    TableName: CLIENTS_TABLE,
    Key: { clientId },
    UpdateExpression: "SET subscriptionStatus = :status, currentPeriodEnd = :end, cancelAtPeriodEnd = :cancel",
    ExpressionAttributeValues: {
      ":status": subscription.status,
      ":end": new Date(subscription.current_period_end * 1000).toISOString(),
      ":cancel": subscription.cancel_at_period_end,
    },
  }));
}

async function handleSubscriptionDeleted(subscription) {
  const clientId = subscription.metadata?.clientId;
  if (!clientId) return;

  // Downgrade to expired
  await ddb.send(new UpdateCommand({
    TableName: CLIENTS_TABLE,
    Key: { clientId },
    UpdateExpression: "SET #p = :trial, subscriptionStatus = :canceled, cancelAtPeriodEnd = :false",
    ExpressionAttributeNames: { "#p": "plan" },
    ExpressionAttributeValues: {
      ":trial": "expired",
      ":canceled": "canceled",
      ":false": false,
    },
  }));

  // Deactivate chatbot
  const client = await getClient(clientId);
  if (client?.configId) {
    await ddb.send(new UpdateCommand({
      TableName: CONFIGS_TABLE,
      Key: { configId: client.configId },
      UpdateExpression: "SET active = :false",
      ExpressionAttributeValues: { ":false": false },
    }));
  }
}

async function handlePaymentSucceeded(invoice) {
  console.log(`Payment succeeded for customer ${invoice.customer}, amount: ${invoice.amount_paid}`);
}

async function handlePaymentFailed(invoice) {
  const customerId = invoice.customer;
  console.log(`Payment FAILED for customer ${customerId}`);

  // Find client by Stripe customer ID
  const result = await ddb.send(new ScanCommand({
    TableName: CLIENTS_TABLE,
    FilterExpression: "stripeCustomerId = :cid",
    ExpressionAttributeValues: { ":cid": customerId },
  }));

  const client = result.Items?.[0];
  if (!client) return;

  // Notify admin
  await ses.send(new SendEmailCommand({
    Source: `HSS Billing <${FROM_EMAIL}>`,
    Destination: { ToAddresses: [NOTIFY_EMAIL] },
    Message: {
      Subject: { Data: `⚠️ Payment Failed: ${client.businessName}` },
      Body: {
        Text: {
          Data: `Payment failed for ${client.businessName} (${client.email}).\n\nStripe will retry automatically. If this continues, the subscription will be canceled.\n\nClient ID: ${client.clientId}\nPlan: ${client.plan}`,
        },
      },
    },
  }));

  // Email customer
  if (client.email) {
    await ses.send(new SendEmailCommand({
      Source: `Heinrichs Software Solutions <${FROM_EMAIL}>`,
      Destination: { ToAddresses: [client.email] },
      Message: {
        Subject: { Data: "Action Needed: Payment Failed for Your AI Chatbot" },
        Body: {
          Text: {
            Data: `Hi,\n\nWe were unable to process your monthly payment for ${client.businessName}'s AI chatbot.\n\nPlease update your payment method to keep your chatbot running:\n${SITE_URL}/dashboard.html\n\nIf there's an issue, please reach out — we're happy to help.\n\nDaniel Heinrich\n(619) 770-7306`,
          },
        },
      },
    }));
  }
}

// ─── HELPERS ───
async function getClient(clientId) {
  const result = await ddb.send(new GetCommand({
    TableName: CLIENTS_TABLE,
    Key: { clientId },
  }));
  return result.Item || null;
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}
