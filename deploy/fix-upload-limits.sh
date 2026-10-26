#!/usr/bin/env bash
# Apply on the VPS (srv) so Play Store app loan submits stop failing with Network Error.
# Does NOT require a new Play Store build — nginx + Node only.
#
# Usage (SSH as root or sudo):
#   bash fix-upload-limits.sh
#
set -euo pipefail

echo "==> Checking fin_backend (PM2)"
if command -v pm2 >/dev/null 2>&1; then
  pm2 describe fin_backend >/dev/null 2>&1 && pm2 restart fin_backend --update-env || echo "WARN: fin_backend not found in PM2 — restart your Node process manually after pulling code"
else
  echo "WARN: pm2 not found"
fi

NGINX_SNIPPET_SRC="$(cd "$(dirname "$0")" && pwd)/nginx-api-uploads.conf"
echo "==> Nginx upload snippet is at: $NGINX_SNIPPET_SRC"
echo ""
echo "MANUAL (required once): merge client_max_body_size 200m + proxy_*_timeout 600s"
echo "into the site that serves https://dhansourcecapital.com/api"
echo ""
echo "Find the config:"
echo "  grep -R \"dhansourcecapital\" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null"
echo ""
echo "Then:"
echo "  sudo nginx -t && sudo systemctl reload nginx"
echo ""
echo "Verify:"
echo "  curl -sS https://dhansourcecapital.com/health || curl -sS https://dhansourcecapital.com/api/../health"
echo "  # From another shell, check nginx allows large bodies:"
echo "  grep -R client_max_body_size /etc/nginx/"
echo ""
echo "Done (Node restart attempted). Nginx edit + reload is still required for Play Store fix."
