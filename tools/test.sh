#!/usr/bin/env bash
# Run the FathomKernel test suite without requiring npm.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node --test test/*.test.mjs
