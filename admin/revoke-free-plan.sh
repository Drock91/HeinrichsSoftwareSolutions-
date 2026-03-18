#!/bin/bash
# Revoke a comped/free plan from a client
#
# Usage: ./revoke-free-plan.sh <email_or_clientId>

set -e

if [ $# -lt 1 ]; then
  echo "Usage: $0 <email_or_clientId>"
  exit 1
fi

IDENTIFIER="$1"
REGION="us-east-2"
TABLE="HSS-CLIENTS"

# Check if identifier is email or clientId
if [[ "$IDENTIFIER" == *"@"* ]]; then
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

# Remove comped fields
aws dynamodb update-item \
  --table-name "$TABLE" \
  --key "{\"clientId\":{\"S\":\"$CLIENT_ID\"}}" \
  --update-expression "REMOVE compedPlan, compedUntil" \
  --region "$REGION"

echo ""
echo "✅ Comped plan revoked for $CLIENT_ID"
echo "   Client will need to pay or be on trial."
