#!/usr/bin/env bash
# Build the Prime Agent cloud-daemon image.
#
#   ./build.sh [image-tag]
#
# Compiles the prime-agent bundle from this checkout, assembles a minimal build
# context (bundle + sibling package.json + Dockerfile), and builds the image.
# Publish the result to the registry the platform's PRIME_AGENT_SANDBOX_IMAGE
# points at.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE_TAG="${1:-${PRIME_AGENT_IMAGE:-primeintellect/prime-agent-daemon:latest}}"
BUNDLE_DIR="$REPO_ROOT/packages/coding-agent/dist/bundle"

echo "Building prime-agent bundle..."
(cd "$REPO_ROOT" && npm run build)

if [[ ! -f "$BUNDLE_DIR/cli.js" ]]; then
    echo "Bundle not found at $BUNDLE_DIR after build" >&2
    exit 1
fi

CONTEXT="$(mktemp -d)"
trap 'rm -rf "$CONTEXT"' EXIT
cp "$SCRIPT_DIR/Dockerfile" "$CONTEXT/"
cp -r "$BUNDLE_DIR" "$CONTEXT/bundle"
# The bundle reads its version from a sibling package.json.
cp "$REPO_ROOT/packages/coding-agent/package.json" "$CONTEXT/bundle/package.json"

docker build -t "$IMAGE_TAG" "$CONTEXT"
echo "Built $IMAGE_TAG"
