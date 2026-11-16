#!/usr/bin/env bash
# Builds and starts the demo UI on http://127.0.0.1:8765
set -euo pipefail
cd "$(dirname "$0")"
: "${GEMINI_API_KEY:?GEMINI_API_KEY must be set}"
go build -o substrate-demo .
exec ./substrate-demo "$@"
