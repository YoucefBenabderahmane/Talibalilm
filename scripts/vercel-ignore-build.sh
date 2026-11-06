#!/usr/bin/env bash
# Vercel "Ignored Build Step". Exit 0 = skip this deployment; anything else = build.
# Compares with the last SUCCESSFUL deployment of this branch, not HEAD^: a push of
# several commits must not be judged by its last commit alone. Any doubt = build.
set -u
prev="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$prev" ] || ! git cat-file -e "${prev}^{commit}" 2>/dev/null; then
  echo "[ignore-build] no reachable previous deployment (${prev:-none}): building"
  exit 1
fi
# The same commit again is a deliberate « Redeploy », almost always after an
# environment variable changed (keys, URLs). Skipping it cancelled the deploy in
# one second and the new values never went live. A git push always brings new
# commits, so this never lets an unchanged push through by mistake.
head="$(git rev-parse HEAD)"
if [ "$prev" = "$head" ]; then
  echo "[ignore-build] redeploy of $head (same commit as the last deployment): building"
  exit 1
fi
if git diff --quiet "$prev" HEAD -- . \
  ':(exclude)docs' ':(exclude)tests' ':(exclude)supabase' ':(exclude).github' \
  ':(exclude)README.md' ':(exclude)CLAUDE.md' ':(exclude)DOMAIN-SWITCH.md' \
  ':(exclude)prisma/README.md'; then
  echo "[ignore-build] only docs/tests/SQL/CI changed since $prev: skipping"
  exit 0
fi
echo "[ignore-build] app files changed since $prev: building"
exit 1
