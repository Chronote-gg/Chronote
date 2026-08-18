#!/usr/bin/env bash
set -euo pipefail

MAX_ATTEMPTS=3
RETRY_DELAY_SECONDS=15

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  if yarn install --frozen-lockfile --network-timeout 600000 "$@"; then
    exit 0
  fi

  if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
    echo "::error::Dependency installation failed after $MAX_ATTEMPTS attempts."
    exit 1
  fi

  echo "::warning::Dependency installation failed on attempt $attempt. Retrying in $RETRY_DELAY_SECONDS seconds."
  sleep "$RETRY_DELAY_SECONDS"
done
