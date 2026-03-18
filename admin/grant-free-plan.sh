#!/bin/bash
# Grant a free plan to a client for X months
#
# Usage: ./grant-free-plan.sh <email_or_clientId> <plan> <months>
# Example: ./grant-free-plan.sh john@example.com standard 3
#          ./grant-free-plan.sh 518b7550-70e1-7078-af4f-5442e275b71f pro 6

set -e

if [ $# -lt 3 ]; then
  echo "Usage: $0 <email_or_clientId> <plan> <months>"
  echo "  plan: standard or pro"
  echo "  months: number of months free"
  exit 1
fi

IDENTIFIER="$1"
PLAN="$2"
MONTHS="$3"
REGION="us-east-2"
TABLE="HSS-CLIENTS"

# Validate plan
if [[ "$PLAN" != "standard" && "$PLAN" != "pro" ]]; then
  echo "Error: plan must be 'standard' or 'pro'"
  exit 1
fi

# Calculate end date
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS
  END_DATE=$(date -v+${MONTHS}m -u +"%Y-%m-%dT%H:%M:%SZ")
else
  # Linux/Git Bash
  END_DATE=$(date -d "+$MONTHS months" -u +"%Y-%m-%dT%H:%M:%SZ")
fi

echo "Granting FREE $PLAN plan until $END_DATE"

# Check if identifier is email or clientId
if [[ "$IDENTIFIER" == *"@"* ]]; then
  # It's an email, need to look up clientId
  echo "Looking up client by email: $IDENTIFIER"
  
  RESULT=$(aws dynamodb scan \
    --table-name "$TABLE" \
    --filter-expression "email = :email" \
    --expression-attribute-values "{\":email\":{\"S\":\"$IDENTIFIER\"}}" \
    --region "$REGION" \
    --query "Items[0].clientId.S" \
    --output text)
  
  if [ "$RESULT" == "None" ] || [ -z "$RESULT" ]; then
    echo "Error: No client found with email $IDENTIFIER"
    exit 1
  fi
  
  CLIENT_ID="$RESULT"
  echo "Found clientId: $CLIENT_ID"
else
  CLIENT_ID="$IDENTIFIER"
fi

# Update the client record
aws dynamodb update-item \
  --table-name "$TABLE" \
  --key "{\"clientId\":{\"S\":\"$CLIENT_ID\"}}" \
  --update-expression "SET compedPlan = :plan, compedUntil = :until, #s = :status" \
  --expression-attribute-names "{\"#s\":\"status\"}" \
  --expression-attribute-values "{\":plan\":{\"S\":\"$PLAN\"},\":until\":{\"S\":\"$END_DATE\"},\":status\":{\"S\":\"active\"}}" \
  --region "$REGION"

echo ""
echo "✅ SUCCESS!"
echo "   Client: $CLIENT_ID"
echo "   Plan: $PLAN (FREE)"
echo "   Expires: $END_DATE"
echo ""
echo "The client now has full $PLAN access without payment."
