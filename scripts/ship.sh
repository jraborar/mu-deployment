#!/bin/bash
set -e

# Require gh CLI
if ! command -v gh &> /dev/null; then
  echo "GitHub CLI not found. Install it: brew install gh && gh auth login"
  exit 1
fi

# Check for any changes (modified, staged, or untracked)
if [ -z "$(git status --porcelain)" ]; then
  echo "Nothing to commit."
  exit 0
fi

# Increment PR counter
COUNTER_FILE=".pr-counter"
CURRENT=$(cat "$COUNTER_FILE" 2>/dev/null || echo "0")
NEXT=$((CURRENT + 1))
PR_BRANCH=$(printf "pr-%04d" $NEXT)

# Prompt for commit message
echo ""
echo "Commit message:"
read -r MSG
if [ -z "$MSG" ]; then
  echo "Commit message required."
  exit 1
fi

# Commit on current branch (main), then branch off
git add -A
git commit -m "$MSG"

# Create PR branch from current state
git checkout -b "$PR_BRANCH"
git push -u origin "$PR_BRANCH"

# Create PR — requires approval via branch protection on main
gh pr create \
  --title "$(printf 'pr-%04d' $NEXT): $MSG" \
  --body "$(cat <<EOF
## Summary
$MSG

## Review checklist
- [ ] Changes reviewed
- [ ] Tested locally
- [ ] Safe to merge to main

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" \
  --base main \
  --head "$PR_BRANCH"

# Update counter and commit it on the PR branch
echo "$NEXT" > "$COUNTER_FILE"
git add "$COUNTER_FILE"
git commit -m "chore: bump PR counter to $(printf '%04d' $NEXT)"
git push

# Return to main
git checkout main

echo ""
echo "PR created: $PR_BRANCH — awaiting approval before merge to main."
