#!/usr/bin/env bash
# Resets the demo between rehearsals: deletes every actor in the demo
# atespace (sandboxes, their snapshots and /workspace state).
# The controller, WorkerPool, ActorTemplate and atespace are left intact.
# Also clear the browser state with the "Reset UI" link (or localStorage).
set -euo pipefail
CTX="${CTX:-kind-gemini-api}"
ATESPACE="${ATESPACE:-gemini-self-hosted}"

actors=$(kubectl ate --context "$CTX" get actors -a "$ATESPACE" -o json 2>/dev/null | jq -r '.actors[]?.metadata.name')
if [[ -z "$actors" ]]; then
  echo "No actors in $ATESPACE."
  exit 0
fi
echo "This deletes these actors in atespace $ATESPACE (context $CTX):"
echo "$actors"
read -r -p "Continue? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || exit 1
for a in $actors; do
  kubectl ate --context "$CTX" delete actor "$a" -a "$ATESPACE" 2>/dev/null && echo "deleted $a"
done
