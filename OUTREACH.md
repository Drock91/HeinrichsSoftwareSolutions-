# Email Outreach Agent — Setup & Usage Guide

## Overview
The outreach agent (`lambda/outreach_handler.mjs`) sends personalized cold emails to prospects via AWS SES, backed by a DynamoDB table for tracking.

---

## AWS Setup (One-Time)

### 1. Create DynamoDB Table
```
Table name:  HSS-OUTREACH-PROSPECTS
Partition key:  email (String)
Billing:  On-Demand (pay per request)
Region:  us-east-2
```

### 2. Create Lambda Function
```
Name:       HSS-OUTREACH-AGENT
Runtime:    Node.js 20.x
Handler:    outreach_handler.handler
Memory:     256 MB
Timeout:    60 seconds
Region:     us-east-2
```

**Environment Variables:**
| Variable | Value |
|---|---|
| `PROSPECTS_TABLE` | `HSS-OUTREACH-PROSPECTS` |
| `FROM_EMAIL` | `contact@heinrichstech.com` |
| `DAILY_LIMIT` | `25` |
| `REGION` | `us-east-2` |

**IAM Permissions needed:**
- `ses:SendEmail` (resource: SES identity for heinrichstech.com)
- `dynamodb:Scan`, `dynamodb:PutItem`, `dynamodb:UpdateItem` (resource: HSS-OUTREACH-PROSPECTS table)

### 3. Schedule Daily Sends (CloudWatch EventBridge)
```
Rule name:   HSS-outreach-daily
Schedule:    cron(0 14 ? * MON-FRI *)   # 10am ET, weekdays only
Target:      HSS-OUTREACH-AGENT Lambda
Input:       {"action": "send-batch"}
```

### 4. Schedule Follow-Up Flagging
```
Rule name:   HSS-outreach-followups
Schedule:    cron(0 12 ? * MON-FRI *)   # 8am ET, weekdays only
Target:      HSS-OUTREACH-AGENT Lambda
Input:       {"action": "schedule-followups"}
```
*(Note: Add a handler case for "schedule-followups" that calls `scheduleFollowups()`)*

---

## Adding Prospects

### Option A: AWS CLI (single)
```bash
aws lambda invoke --function-name HSS-OUTREACH-AGENT \
  --payload '{"action":"add-prospect","prospect":{"email":"owner@business.com","contactName":"John","businessName":"Johns Pizza","industry":"restaurant"}}' \
  response.json
```

### Option B: AWS CLI (bulk from template)
```bash
# Edit lambda/prospects-template.json with real prospects, then:
aws lambda invoke --function-name HSS-OUTREACH-AGENT \
  --payload "{\"action\":\"add-prospects\",\"prospects\":$(cat lambda/prospects-template.json)}" \
  response.json
```

### Option C: DynamoDB Console
Add items directly in the AWS DynamoDB console with these fields:
- `email` (String, partition key) — required
- `contactName` (String) — required
- `businessName` (String) — required
- `industry` (String) — restaurant, dental, legal, real estate, contractor, ecommerce
- `website` (String)
- `phone` (String)
- `notes` (String)
- `source` (String) — manual, bulk-import, scraped, referral
- `status` (String) — set to `pending`
- `emailCount` (Number) — set to `0`
- `createdAt` (String) — ISO date

---

## Prospect Lifecycle

```
pending → initial_sent → followup_ready → followup_sent → done
```

| Status | Meaning |
|---|---|
| `pending` | Not yet emailed |
| `initial_sent` | First email sent |
| `followup_ready` | 5+ days since initial, flagged for follow-up |
| `followup_sent` | Follow-up email sent |

---

## Email Templates

The agent includes 3 templates:
1. **General** — Works for any industry
2. **Industry** — Customized hooks for restaurant, dental, legal, real estate, contractor, ecommerce
3. **Follow-up** — Shorter, sent 5+ days after no response

---

## Checking Status
```bash
aws lambda invoke --function-name HSS-OUTREACH-AGENT \
  --payload '{"action":"status"}' \
  response.json && cat response.json
```

---

## SES Production Access
If SES is still in sandbox mode, you can only send to verified emails. To send to real prospects:
1. Go to AWS SES Console → Account dashboard
2. Click "Request production access"
3. Describe your use case (B2B outreach for software services)
4. Usually approved within 24 hours

---

## Finding Prospects
Good sources for building your prospect list:
- **Google Maps** — Search "[industry] near [city]", check if they have a website but no chat
- **Yelp** — High-review businesses with websites
- **LinkedIn** — Business owners in target industries
- **Local Chamber of Commerce** directories
- **Industry-specific directories** (Avvo for lawyers, Zocdoc for dentists, etc.)

Focus on businesses that:
- Have a website but NO live chat
- Get good reviews (they care about customer experience)
- Are in industries where after-hours questions are common
- Are locally owned (more likely to respond to personalized outreach)
