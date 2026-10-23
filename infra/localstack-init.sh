#!/usr/bin/env bash
# MUFF-64 — LocalStack "ready" hook (compose.yaml mounts this into
# /etc/localstack/init/ready.d/). Runs once inside the LocalStack container
# after S3 is up: create the one MUFF bucket and mirror ./data into it so the
# containerised MCP server sees the same blobs a local `npm run mcp` would.
set -euo pipefail
awslocal s3 mb "s3://muff-local" 2>/dev/null || true
if [[ -d /seed ]]; then
  awslocal s3 sync /seed "s3://muff-local" --exclude ".DS_Store"
fi
echo "seeded s3://muff-local from ./data"
