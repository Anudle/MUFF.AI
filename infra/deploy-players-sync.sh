#!/usr/bin/env bash
#
# MUFF-49 step 3 — deploy the daily Sleeper players sync. Idempotent, same
# philosophy as deploy.sh / deploy-digest.sh: plain CLI, every call visible.
#
#   bundle → zip → S3 bucket (shared with digest history) → IAM roles → Lambda → EventBridge Scheduler
#
# No secrets, no .env: Sleeper is a zero-auth API and the Lambda only needs
# the bucket name. Order-independent with deploy-digest.sh — whichever runs
# first creates the bucket.
#
# Teardown:
#   aws scheduler delete-schedule --name muff-players-sync-daily --region us-east-2
#   aws lambda delete-function --function-name muff-players-sync --region us-east-2
#   aws iam delete-role-policy --role-name muff-players-sync-lambda-role --policy-name muff-players-sync-permissions
#   aws iam delete-role --role-name muff-players-sync-lambda-role
#   aws iam delete-role-policy --role-name muff-players-sync-scheduler-role --policy-name muff-players-sync-invoke
#   aws iam delete-role --role-name muff-players-sync-scheduler-role
#   aws s3 rm s3://muff-digest-history-<account-id>/players/sleeper-nfl.json

set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${AWS_REGION:-us-east-2}"
FUNC="muff-players-sync"
ROLE="muff-players-sync-lambda-role"
POLICY_NAME="muff-players-sync-permissions"
SCHED_ROLE="muff-players-sync-scheduler-role"
SCHEDULE="muff-players-sync-daily"
PLAYERS_KEY="players/sleeper-nfl.json"
BUNDLE_DIR="dist/players-sync"

# Daily 05:00 America/Denver, year-round (injury designations move in the
# offseason too, and the run costs ~nothing). Two hours before the Tuesday
# digest, so the digest always finds a same-morning map.
CRON="cron(0 5 * * ? *)"
TZ_NAME="America/Denver"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="muff-digest-history-$ACCOUNT_ID"

echo "==> Bundling src/sleeper/sync-lambda.ts"
npx esbuild src/sleeper/sync-lambda.ts --bundle --platform=node --format=esm --target=node22 \
  --outfile="$BUNDLE_DIR/index.mjs" \
  --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
  --log-level=warning
(cd "$BUNDLE_DIR" && rm -f function.zip && zip -q function.zip index.mjs)
echo "    $(du -h "$BUNDLE_DIR/function.zip" | cut -f1) zipped"

# --- S3: same bucket as the digest history, created by whichever deploy runs first
if ! aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  echo "==> Creating bucket $BUCKET"
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  aws s3api put-public-access-block --bucket "$BUCKET" \
    --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
fi

# --- IAM: Lambda execution role ----------------------------------------------
NEW_ROLE=0
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  echo "==> Creating role $ROLE"
  aws iam create-role --role-name "$ROLE" \
    --description "MUFF.ai Sleeper players sync Lambda execution role" \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}]
    }' >/dev/null
  NEW_ROLE=1
fi
# GetObject too, not just Put: the shared read path peeks at the existing
# blob's fetched_at before deciding to refetch.
aws iam put-role-policy --role-name "$ROLE" --policy-name "$POLICY_NAME" \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {"Effect": "Allow",
       "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
       "Resource": "arn:aws:logs:*:*:*"},
      {"Effect": "Allow",
       "Action": ["s3:GetObject", "s3:PutObject"],
       "Resource": "arn:aws:s3:::'"$BUCKET"'/players/*"}
    ]
  }'
ROLE_ARN="$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)"
if [[ "$NEW_ROLE" == 1 ]]; then
  echo "    waiting 10s for IAM propagation"
  sleep 10
fi

# --- Lambda ------------------------------------------------------------------
# 512MB / 120s: the job is downloading and JSON.parsing a 14.6MB blob once.
ENV_JSON='{"Variables":{"HISTORY_BUCKET":"'"$BUCKET"'"}}'

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
    --description "MUFF.ai daily Sleeper players sync (14.6MB /players/nfl → trimmed map in S3)" \
    --runtime nodejs22.x --handler index.handler \
    --role "$ROLE_ARN" \
    --zip-file "fileb://$BUNDLE_DIR/function.zip" \
    --timeout 120 --memory-size 512 \
    --environment "$ENV_JSON" --region "$REGION" >/dev/null
  aws lambda wait function-active --function-name "$FUNC" --region "$REGION"
fi
FUNC_ARN="$(aws lambda get-function --function-name "$FUNC" --region "$REGION" --query Configuration.FunctionArn --output text)"

# --- EventBridge Scheduler ---------------------------------------------------
if ! aws iam get-role --role-name "$SCHED_ROLE" >/dev/null 2>&1; then
  echo "==> Creating role $SCHED_ROLE"
  aws iam create-role --role-name "$SCHED_ROLE" \
    --description "Lets EventBridge Scheduler invoke the MUFF.ai players sync Lambda" \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{"Effect": "Allow", "Principal": {"Service": "scheduler.amazonaws.com"}, "Action": "sts:AssumeRole",
                     "Condition": {"StringEquals": {"aws:SourceAccount": "'"$ACCOUNT_ID"'"}}}]
    }' >/dev/null
  sleep 10
fi
aws iam put-role-policy --role-name "$SCHED_ROLE" --policy-name muff-players-sync-invoke \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{"Effect": "Allow", "Action": "lambda:InvokeFunction", "Resource": "'"$FUNC_ARN"'"}]
  }'
SCHED_ROLE_ARN="$(aws iam get-role --role-name "$SCHED_ROLE" --query Role.Arn --output text)"

# 2 retries: a failed sync just means readers serve yesterday's map, so no
# heroics — but don't give up on one flaky fetch either.
TARGET_JSON='{"Arn":"'"$FUNC_ARN"'","RoleArn":"'"$SCHED_ROLE_ARN"'","Input":"{}","RetryPolicy":{"MaximumRetryAttempts":2}}'
SCHED_ARGS=(
  --name "$SCHEDULE" --region "$REGION"
  --schedule-expression "$CRON"
  --schedule-expression-timezone "$TZ_NAME"
  --flexible-time-window "Mode=FLEXIBLE,MaximumWindowInMinutes=15"
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
echo "✅ Players sync deployed."
echo "   Schedule: $CRON $TZ_NAME (±15 min flex window)"
echo "   Run now:  aws lambda invoke --function-name $FUNC --region $REGION \\"
echo "               --cli-read-timeout 130 /tmp/players-sync-out.json && cat /tmp/players-sync-out.json"
echo "   Inspect:  aws s3api head-object --bucket $BUCKET --key $PLAYERS_KEY"
