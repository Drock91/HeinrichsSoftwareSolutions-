#!/bin/bash
# =====================================================
# HEINRICHS SOFTWARE SOLUTIONS — AWS S3 Static Deploy
# Estimated cost: $0.50 - $1.00/month
# =====================================================

# Configuration — update these values
BUCKET_NAME="heinrichssoftware.com"
REGION="us-east-1"
DISTRIBUTION_ID=""  # CloudFront distribution ID (optional)

SITE_DIR="$(dirname "$0")"

echo "=========================================="
echo "  HSS — Deploying to AWS S3"
echo "=========================================="

# Sync all files to S3
echo "Uploading files to s3://${BUCKET_NAME}..."
aws s3 sync "$SITE_DIR" "s3://${BUCKET_NAME}" \
  --exclude "deploy.sh" \
  --exclude "DEPLOY.md" \
  --exclude ".DS_Store" \
  --exclude "*.sh" \
  --exclude "*.md" \
  --delete

# Set correct content types
echo "Setting content types..."
aws s3 cp "s3://${BUCKET_NAME}" "s3://${BUCKET_NAME}" \
  --recursive \
  --exclude "*" \
  --include "*.html" \
  --content-type "text/html" \
  --metadata-directive REPLACE

aws s3 cp "s3://${BUCKET_NAME}" "s3://${BUCKET_NAME}" \
  --recursive \
  --exclude "*" \
  --include "*.css" \
  --content-type "text/css" \
  --metadata-directive REPLACE

aws s3 cp "s3://${BUCKET_NAME}" "s3://${BUCKET_NAME}" \
  --recursive \
  --exclude "*" \
  --include "*.js" \
  --content-type "application/javascript" \
  --metadata-directive REPLACE

# Invalidate CloudFront cache (if distribution ID is set)
if [ -n "$DISTRIBUTION_ID" ]; then
  echo "Invalidating CloudFront cache..."
  aws cloudfront create-invalidation \
    --distribution-id "$DISTRIBUTION_ID" \
    --paths "/*"
fi

echo ""
echo "=========================================="
echo "  Deploy complete!"
echo "  http://${BUCKET_NAME}.s3-website-${REGION}.amazonaws.com"
echo "=========================================="
