# AWS S3 Deployment Guide — Heinrichs Software Solutions

## Cost: ~$0.50-1.00/month (S3 static hosting + CloudFront)

---

## Step 1: Install AWS CLI

```bash
# Windows (installer)
msiexec.exe /i https://awscli.amazonaws.com/AWSCLIV2.msi

# Or with winget
winget install Amazon.AWSCLI

# Verify
aws --version
```

## Step 2: Configure AWS Credentials

```bash
aws configure
# AWS Access Key ID: (your key)
# AWS Secret Access Key: (your secret)
# Default region: us-east-1
# Default output: json
```

## Step 3: Create S3 Bucket

```bash
# Create bucket (use your domain name)
aws s3 mb s3://heinrichssoftware.com --region us-east-1

# Enable static website hosting
aws s3 website s3://heinrichssoftware.com \
  --index-document index.html \
  --error-document index.html
```

## Step 4: Set Bucket Policy (Public Read)

Create a file `bucket-policy.json`:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PublicReadGetObject",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::heinrichssoftware.com/*"
  }]
}
```

Apply it:
```bash
aws s3api put-bucket-policy \
  --bucket heinrichssoftware.com \
  --policy file://bucket-policy.json
```

## Step 5: Deploy

```bash
# From the website directory:
bash deploy.sh
```

Your site will be live at:
`http://heinrichssoftware.com.s3-website-us-east-1.amazonaws.com`

---

## Step 6 (Optional): CloudFront CDN + Custom Domain

### Create CloudFront Distribution
1. Go to AWS Console → CloudFront → Create Distribution
2. Origin Domain: `heinrichssoftware.com.s3-website-us-east-1.amazonaws.com`
3. Viewer Protocol Policy: **Redirect HTTP to HTTPS**
4. Default Root Object: `index.html`
5. Alternate Domain Name (CNAME): `heinrichssoftware.com`, `www.heinrichssoftware.com`
6. SSL Certificate: Request free cert via ACM (must be in us-east-1)

### Route 53 (Custom Domain)
1. Register domain or transfer to Route 53
2. Create hosted zone for `heinrichssoftware.com`
3. Create A record → Alias → CloudFront distribution
4. Create AAAA record → Alias → CloudFront distribution

### Update deploy.sh
Set the `DISTRIBUTION_ID` variable in deploy.sh to auto-invalidate cache on deploy.

---

## Estimated Monthly Costs

| Service        | Cost          |
|---------------|---------------|
| S3 Storage     | ~$0.02/month  |
| S3 Requests    | ~$0.01/month  |
| CloudFront     | ~$0.00-0.50   |
| Route 53       | $0.50/month   |
| ACM (SSL)      | Free          |
| **Total**      | **~$0.50-1.00/month** |

---

## Quick Deploy Commands

```bash
# First-time setup
aws s3 mb s3://heinrichssoftware.com --region us-east-1
aws s3 website s3://heinrichssoftware.com --index-document index.html --error-document index.html

# Deploy/Update
bash deploy.sh

# Check site
curl -I http://heinrichssoftware.com.s3-website-us-east-1.amazonaws.com
```

---

## AI Chatbot Deployment

The site includes an AI chatbot powered by Anthropic Claude. Here's how to deploy the backend:

### 1. API Keys (already in GitHub Secrets)
Your repo already has these secrets configured:
- `GOOGLE_API_KEY` — **Primary** (Gemini 2.0 Flash, free tier: 15 req/min, 1M tokens/day)
- `GROQ_API_KEY` — **Fallback #1** (Llama 3.3 70B, free tier: 30 req/min)
- `MISTRAL_API_KEY` — Fallback #2
- `OPENAI_API_KEY` — Fallback #3
- `ANTHROPIC_API_KEY` — Fallback #4

The Lambda tries each provider in order. If Google is down or rate-limited, it automatically falls through to Groq, then Mistral, then OpenAI, then Anthropic.

### 2. Create the Chat Lambda Function

```bash
# Create a zip of the handler (no external dependencies needed — uses urllib)
cd lambda
zip chat_handler.zip chat_handler.py
```

```bash
# Create the Lambda function
aws lambda create-function \
  --function-name hss-chat-handler \
  --runtime python3.12 \
  --handler chat_handler.lambda_handler \
  --role arn:aws:iam::YOUR_ACCOUNT_ID:role/YOUR_LAMBDA_ROLE \
  --zip-file fileb://chat_handler.zip \
  --timeout 30 \
  --memory-size 256 \
  --environment "Variables={ANTHROPIC_API_KEY=sk-ant-YOUR_KEY_HERE}" \
  --region us-east-2
```

### 3. Add API Gateway Route

Using the existing API Gateway (`pd30lkyyof`):

```bash
# Get the API ID
aws apigateway get-rest-apis --region us-east-2

# Create /chat resource
aws apigateway create-resource \
  --rest-api-id pd30lkyyof \
  --parent-id YOUR_ROOT_RESOURCE_ID \
  --path-part chat \
  --region us-east-2

# Create POST method
aws apigateway put-method \
  --rest-api-id pd30lkyyof \
  --resource-id YOUR_CHAT_RESOURCE_ID \
  --http-method POST \
  --authorization-type NONE \
  --region us-east-2

# Create OPTIONS method (for CORS)
aws apigateway put-method \
  --rest-api-id pd30lkyyof \
  --resource-id YOUR_CHAT_RESOURCE_ID \
  --http-method OPTIONS \
  --authorization-type NONE \
  --region us-east-2

# Link POST to Lambda
aws apigateway put-integration \
  --rest-api-id pd30lkyyof \
  --resource-id YOUR_CHAT_RESOURCE_ID \
  --http-method POST \
  --type AWS_PROXY \
  --integration-http-method POST \
  --uri "arn:aws:apigateway:us-east-2:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-2:YOUR_ACCOUNT_ID:function:hss-chat-handler/invocations" \
  --region us-east-2

# Grant API Gateway permission to invoke Lambda
aws lambda add-permission \
  --function-name hss-chat-handler \
  --statement-id apigateway-chat \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --region us-east-2

# Deploy to prod stage
aws apigateway create-deployment \
  --rest-api-id pd30lkyyof \
  --stage-name prod \
  --region us-east-2
```

### 4. Update Lambda Code (future changes)

```bash
cd lambda
zip chat_handler.zip chat_handler.py
aws lambda update-function-code \
  --function-name hss-chat-handler \
  --zip-file fileb://chat_handler.zip \
  --region us-east-2
```

### Chatbot Cost Estimate

| Component       | Cost              |
|----------------|-------------------|
| Anthropic API   | ~$0.01-0.03/chat  |
| Lambda          | Free tier covers it|
| API Gateway     | Free tier covers it|
| **Per 1,000 chats** | **~$10-30**    |
