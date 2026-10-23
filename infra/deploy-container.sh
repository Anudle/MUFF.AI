#!/usr/bin/env bash
#
# MUFF-64 — deploy the MCP server as a Lambda CONTAINER IMAGE.
#
#   docker build → ECR push → Lambda (PackageType: Image) → verify
#
# Owns: the ECR repository, the image, and the function's package type.
# Does NOT own the secret, the IAM role or the API Gateway — infra/deploy.sh
# created those and they are unchanged by this switch. Run deploy.sh once
# first on a fresh account.
#
# One-way door, by AWS design: a function's PackageType is immutable. Moving
# muff-mcp-server from Zip to Image means delete + recreate under the same
# name. The ARN is identical afterwards, so the API Gateway integration keeps
# pointing at it; only the resource-based invoke permission is lost on
# delete, and it is re-added below. Going back to zip is the same dance in
# reverse (delete, then `npm run deploy`).
#
# Teardown of what this script adds:
#   aws ecr delete-repository --repository-name muff-mcp-server --force --region us-east-2

set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${AWS_REGION:-us-east-2}"
FUNC="muff-mcp-server"
ROLE="muff-mcp-lambda-role"
REPO="muff-mcp-server"
SECRET="muff/yahoo-tokens"
API_NAME="muff-mcp-api"
TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"

get_env() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }

command -v docker >/dev/null || { echo "❌ docker not found — install Docker Desktop / OrbStack / Colima."; exit 1; }
[[ -f .env ]] || { echo "❌ No .env — copy .env.example and fill in Yahoo creds."; exit 1; }
YAHOO_CLIENT_ID="$(get_env YAHOO_CLIENT_ID)"
YAHOO_CLIENT_SECRET="$(get_env YAHOO_CLIENT_SECRET)"
MCP_AUTH_TOKEN="$(get_env MCP_AUTH_TOKEN)"
[[ -n "$YAHOO_CLIENT_ID" && -n "$YAHOO_CLIENT_SECRET" && -n "$MCP_AUTH_TOKEN" ]] || {
  echo "❌ YAHOO_CLIENT_ID / YAHOO_CLIENT_SECRET / MCP_AUTH_TOKEN missing from .env (run npm run deploy once first)"; exit 1; }
aws iam get-role --role-name "$ROLE" >/dev/null 2>&1 || { echo "❌ Role $ROLE missing — run npm run deploy once first."; exit 1; }
ROLE_ARN="$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

# --- ECR ---------------------------------------------------------------------
if ! aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Creating ECR repository $REPO"
  aws ecr create-repository --repository-name "$REPO" --region "$REGION" \
    --image-scanning-configuration scanOnPush=true >/dev/null
fi
REPO_URI="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$REPO"

echo "==> Building $REPO_URI:$TAG"
# --platform: Lambda x86_64 regardless of an Apple-silicon host.
# --provenance/--sbom=false: BuildKit's default attestation manifests make an
# OCI image index, which Lambda rejects ("image manifest ... not supported").
docker build --platform linux/amd64 --provenance=false --sbom=false \
  -t "$REPO_URI:$TAG" -t "$REPO_URI:latest" .

echo "==> Pushing"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com" >/dev/null
docker push "$REPO_URI:$TAG" >/dev/null
docker push "$REPO_URI:latest" >/dev/null
IMAGE_URI="$REPO_URI:$TAG"

# --- Lambda ------------------------------------------------------------------
ENV_JSON="$(TOKENS_SECRET_ID="$SECRET" YAHOO_CLIENT_ID="$YAHOO_CLIENT_ID" \
  YAHOO_CLIENT_SECRET="$YAHOO_CLIENT_SECRET" MCP_AUTH_TOKEN="$MCP_AUTH_TOKEN" \
  node -e 'const p = ["TOKENS_SECRET_ID","YAHOO_CLIENT_ID","YAHOO_CLIENT_SECRET","MCP_AUTH_TOKEN"];
    console.log(JSON.stringify({Variables: Object.fromEntries(p.map(k => [k, process.env[k]]))}))')"

PACKAGE_TYPE="$(aws lambda get-function-configuration --function-name "$FUNC" --region "$REGION" \
  --query PackageType --output text 2>/dev/null || echo NONE)"

if [[ "$PACKAGE_TYPE" == "Zip" ]]; then
  echo "==> $FUNC is zip-packaged; PackageType is immutable → delete + recreate as Image"
  aws lambda delete-function --function-name "$FUNC" --region "$REGION"
  PACKAGE_TYPE=NONE
fi

if [[ "$PACKAGE_TYPE" == "Image" ]]; then
  echo "==> Updating $FUNC image → $TAG"
  aws lambda update-function-code --function-name "$FUNC" --image-uri "$IMAGE_URI" --region "$REGION" >/dev/null
  aws lambda wait function-updated --function-name "$FUNC" --region "$REGION"
  aws lambda update-function-configuration --function-name "$FUNC" --environment "$ENV_JSON" --region "$REGION" >/dev/null
  aws lambda wait function-updated --function-name "$FUNC" --region "$REGION"
else
  echo "==> Creating $FUNC from $IMAGE_URI"
  aws lambda create-function --function-name "$FUNC" \
    --description "MUFF.ai Yahoo Fantasy MCP server (Streamable HTTP, stateless; container image)" \
    --package-type Image --code "ImageUri=$IMAGE_URI" --architectures x86_64 \
    --role "$ROLE_ARN" --timeout 30 --memory-size 512 \
    --environment "$ENV_JSON" --region "$REGION" >/dev/null
  aws lambda wait function-active --function-name "$FUNC" --region "$REGION"

  # Recreating drops the resource policy; the API Gateway must be allowed back in.
  API_ID="$(aws apigatewayv2 get-apis --region "$REGION" \
    --query "Items[?Name=='$API_NAME'].ApiId | [0]" --output text)"
  if [[ -n "$API_ID" && "$API_ID" != "None" ]]; then
    aws lambda add-permission --function-name "$FUNC" --statement-id ApiGatewayInvoke \
      --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
      --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT_ID:$API_ID/*" --region "$REGION" >/dev/null \
      || echo "    (invoke permission already present)"
  else
    echo "⚠️  No HTTP API named $API_NAME — run npm run deploy to create the front door."
  fi
fi

echo
echo "✅ $FUNC now runs $IMAGE_URI"
echo "   Smoke test:  npm run verify:remote"
