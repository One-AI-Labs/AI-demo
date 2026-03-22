#!/usr/bin/env bash
# 在云服务器项目根目录执行：bash scripts/deploy-vps.sh
# 要求：已配置 origin、Node/npm、pm2 应用名 ai-demo
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

git fetch origin
git reset --hard origin/main

npm ci

pm2 restart ai-demo
