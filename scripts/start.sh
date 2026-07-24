#!/bin/sh
set -e

# Authenticate Terminus with machine token
if [ -n "$TERMINUS_TOKEN" ]; then
  echo "[startup] Authenticating Terminus..."
  terminus auth:login --machine-token="$TERMINUS_TOKEN"
  echo "[startup] Terminus authenticated as: $(terminus auth:whoami)"
else
  echo "[startup] WARNING: TERMINUS_TOKEN not set — deployments will fail"
fi

# Set up SSH key for Pantheon git access (alignment check)
if [ -n "$PANTHEON_SSH_KEY" ]; then
  echo "[startup] Configuring SSH key..."
  mkdir -p ~/.ssh
  echo "$PANTHEON_SSH_KEY" > ~/.ssh/id_rsa
  chmod 600 ~/.ssh/id_rsa
  # Trust Pantheon's git servers
  ssh-keyscan -p 2222 codeserver.dev.drush.in >> ~/.ssh/known_hosts 2>/dev/null || true
  echo "[startup] SSH key configured"
else
  echo "[startup] WARNING: PANTHEON_SSH_KEY not set — git alignment check will be skipped"
fi

echo "[startup] Starting Mu Deployment..."
exec node_modules/.bin/next start -p "${PORT:-3000}"
