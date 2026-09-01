#!/usr/bin/env bash
#
# MUFF-43 — deploy the scheduled Tuesday digest. Idempotent, same philosophy
# as deploy.sh (the MCP server): plain CLI, every call visible.
#
#   bundle → zip → S3 history bucket (+seed) → IAM roles → Lambda → EventBridge Scheduler
#
# Requires the MCP-server deploy to have run first (it owns the Yahoo tokens
# secret this Lambda reads).
#
# Teardown:
#   aws scheduler delete-schedule --name muff-digest-tuesday --region us-east-2
#   aws lambda delete-function --function-name muff-digest --region us-east-2
#   aws iam delete-role-policy --role-name muff-digest-lambda-role --policy-name muff-digest-permissions
#   aws iam delete-role --role-name muff-digest-lambda-role
#   aws iam delete-role-policy --role-name muff-digest-scheduler-role --policy-name muff-digest-invoke
#   aws iam delete-role --role-name muff-digest-scheduler-role
#   aws s3 rb s3://muff-digest-history-<account-id> --force

set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${AWS_REGION:-us-east-2}"
FUNC="muff-digest"
ROLE="muff-digest-lambda-role"
POLICY_NAME="muff-digest-permissions"
SCHED_ROLE="muff-digest-scheduler-role"
SCHEDULE="muff-digest-tuesday"
SECRET="muff/yahoo-tokens"
HISTORY_KEY="digest-history.json"
BUNDLE_DIR="dist/digest"

# Tuesday 7:00 America/Denver — Scheduler handles the MST/MDT flip, so this
# is truly "7am Mountain" all season. Window ≈ first digest Tuesday after
# 2026 week 1 through the Tuesday after week 17. Adjust when the 2026 NFL
# schedule is confirmed.
CRON="cron(0 7 ? * TUE *)"
TZ_NAME="America/Denver"
START_DATE="2026-09-15T00:00:00"
END_DATE="2027-01-06T00:00:00"

get_env() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }

[[ -f .env ]] || { echo "❌ No .env"; exit 1; }
ANTHROPIC_API_KEY="$(get_env ANTHROPIC_API_KEY)"
TELEGRAM_BOT_TOKEN="$(get_env TELEGRAM_BOT_TOKEN)"
TELEGRAM_CHAT_ID="$(get_env TELEGRAM_CHAT_ID)"
for v in ANTHROPIC_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do
  [[ -n "${!v}" ]] || { echo "❌ $v missing from .env"; exit 1; }
done

aws secretsmanager describe-secret --secret-id "$SECRET" --region "$REGION" >/dev/null 2>&1 \
  || { echo "❌ Secret $SECRET not found — run 'npm run deploy' (MCP server) first."; exit 1; }
SECRET_ARN="$(aws secretsmanager describe-secret --secret-id "$SECRET" --region "$REGION" --query ARN --output text)"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="muff-digest-history-$ACCOUNT_ID"

echo "==> Bundling src/digest/lambda.ts"
npx esbuild src/digest/lambda.ts --bundle --platform=node --format=esm --target=node22 \
  --outfile="$BUNDLE_DIR/index.mjs" \
  --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
  --log-level=warning
(cd "$BUNDLE_DIR" && rm -f function.zip && zip -q function.zip index.mjs)
echo "    $(du -h "$BUNDLE_DIR/function.zip" | cut -f1) zipped"

# --- S3: history bucket, private, seeded once --------------------------------
# Two things live here: digest-history.json (power rankings, read+written every
# run) and runs/ (MUFF-16 archive, one immutable record per run).
if ! aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  echo "==> Creating bucket $BUCKET"
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  aws s3api put-public-access-block --bucket "$BUCKET" \
    --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
fi
# Seed from the local file only if S3 has no history yet — after that the
# LAMBDA owns it (same never-clobber rule as the tokens secret).
if ! aws s3api head-object --bucket "$BUCKET" --key "$HISTORY_KEY" >/dev/null 2>&1; then
  if [[ -f data/digest-history.json ]]; then
    echo "==> Seeding $HISTORY_KEY from local data/"
    aws s3 cp data/digest-history.json "s3://$BUCKET/$HISTORY_KEY" >/dev/null
  fi
fi

# --- IAM: Lambda execution role ----------------------------------------------
NEW_ROLE=0
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  echo "==> Creating role $ROLE"
  aws iam create-role --role-name "$ROLE" \
    --description "MUFF.ai digest Lambda execution role" \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}]
    }' >/dev/null
  NEW_ROLE=1
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name "$POLICY_NAME" \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {"Effect": "Allow",
       "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
       "Resource": "arn:aws:logs:*:*:*"},
      {"Effect": "Allow",
       "Action": ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"],
       "Resource": "'"$SECRET_ARN"'"},
      {"Effect": "Allow",
       "Action": ["s3:GetObject", "s3:PutObject"],
       "Resource": ["arn:aws:s3:::'"$BUCKET"'/'"$HISTORY_KEY"'",
                    "arn:aws:s3:::'"$BUCKET"'/runs/*",
                    "arn:aws:s3:::'"$BUCKET"'/players/*"]}
    ]
  }'
ROLE_ARN="$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)"
if [[ "$NEW_ROLE" == 1 ]]; then
  echo "    waiting 10s for IAM propagation"
  sleep 10
fi

# --- Lambda ------------------------------------------------------------------
# Timeout 300s: an Opus structured-output call plus Yahoo fan-out is slow-ish;
# the schedule only fires once a week, so generous beats flaky.
ENV_JSON="$(TOKENS_SECRET_ID="$SECRET" HISTORY_BUCKET="$BUCKET" \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" \
  TELEGRAM_CHAT_ID="$TELEGRAM_CHAT_ID" \
  node -e 'const p = ["TOKENS_SECRET_ID","HISTORY_BUCKET","ANTHROPIC_API_KEY","TELEGRAM_BOT_TOKEN","TELEGRAM_CHAT_ID"];
    console.log(JSON.stringify({Variables: Object.fromEntries(p.map(k => [k, process.env[k]]))}))')"

if aws lambda get-function --function-name "$FUNC" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Updating $FUNC"
  aws lambda update-function-code --function-name "$FUNC" \
    --zip-file "fileb://$BUNDLE_DIR/function.zip" --region "$REGION" >/dev/null
  aws lambda wait function-updated --function-name "$FUNC" --region "$REGION"
  aws lambda update-function-configuration --function-name "$FUNC" \
    --environment "$ENV_JSON" --region "$REGION" >/dev/null
  aws lambda wait function-updated --function-name "$FUNC" --region "$REGION"
else
  echo "==> Creating $FUNC"
  aws lambda create-function --function-name "$FUNC" \
    --description "MUFF.ai Tuesday digest (EventBridge Scheduler → gather/generate/deliver)" \
    --runtime nodejs22.x --handler index.handler \
    --role "$ROLE_ARN" \
    --zip-file "fileb://$BUNDLE_DIR/function.zip" \
    --timeout 300 --memory-size 512 \
    --environment "$ENV_JSON" --region "$REGION" >/dev/null
  aws lambda wait function-active --function-name "$FUNC" --region "$REGION"
fi
FUNC_ARN="$(aws lambda get-function --function-name "$FUNC" --region "$REGION" --query Configuration.FunctionArn --output text)"

# --- EventBridge Scheduler ---------------------------------------------------
# Scheduler (unlike classic EventBridge rules) invokes via an IAM role, not a
# lambda resource policy — so it needs its own assumable role.
if ! aws iam get-role --role-name "$SCHED_ROLE" >/dev/null 2>&1; then
  echo "==> Creating role $SCHED_ROLE"
  aws iam create-role --role-name "$SCHED_ROLE" \
    --description "Lets EventBridge Scheduler invoke the MUFF.ai digest Lambda" \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{"Effect": "Allow", "Principal": {"Service": "scheduler.amazonaws.com"}, "Action": "sts:AssumeRole",
                     "Condition": {"StringEquals": {"aws:SourceAccount": "'"$ACCOUNT_ID"'"}}}]
    }' >/dev/null
  sleep 10
fi
aws iam put-role-policy --role-name "$SCHED_ROLE" --policy-name muff-digest-invoke \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{"Effect": "Allow", "Action": "lambda:InvokeFunction", "Resource": "'"$FUNC_ARN"'"}]
  }'
SCHED_ROLE_ARN="$(aws iam get-role --role-name "$SCHED_ROLE" --query Role.Arn --output text)"

# {} payload = "last completed week, deliver". Two retries max: a failed run
# costs an API call each retry, and a digest that's 3-for-3 broken needs a
# human, not attempt #185 (the default retry policy is genuinely 185).
# Target must be JSON (not shorthand): Input is a *string* containing JSON.
TARGET_JSON='{"Arn":"'"$FUNC_ARN"'","RoleArn":"'"$SCHED_ROLE_ARN"'","Input":"{}","RetryPolicy":{"MaximumRetryAttempts":2}}'
SCHED_ARGS=(
  --name "$SCHEDULE" --region "$REGION"
  --schedule-expression "$CRON"
  --schedule-expression-timezone "$TZ_NAME"
  --start-date "$START_DATE" --end-date "$END_DATE"
  --flexible-time-window "Mode=OFF"
  --target "$TARGET_JSON"
)
if aws scheduler get-schedule --name "$SCHEDULE" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Updating schedule $SCHEDULE"
  aws scheduler update-schedule "${SCHED_ARGS[@]}" >/dev/null
else
  echo "==> Creating schedule $SCHEDULE"
  aws scheduler create-schedule "${SCHED_ARGS[@]}" >/dev/null
fi

echo
echo "✅ Digest deployed."
echo "   Schedule: $CRON $TZ_NAME, $START_DATE → $END_DATE"
echo "   Dry run:  aws lambda invoke --function-name $FUNC --region $REGION \\"
echo "               --cli-read-timeout 320 --payload '{\"dry_run\": true}' \\"
echo "               --cli-binary-format raw-in-base64-out /tmp/digest-out.json"
