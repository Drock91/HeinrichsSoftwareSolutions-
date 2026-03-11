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
