#!/bin/bash

# Allow tests to run without exiting on errors
if [ "$TEST_MODE" = "1" ]; then
    set +e
fi

# Read .env vars
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

if [ -z "$GH_SOURCE_TOKEN" ]; then
    echo "Error: GH_SOURCE_TOKEN environment variable must be set to a valid GitHub Personal Access Token"
    exit 1
fi

if [ -z "$GH_TARGET_TOKEN" ]; then
    echo "Error: GH_TARGET_TOKEN environment variable must be set to a valid GitHub Personal Access Token"
    exit 1
fi

SUCCEEDED=0
FAILED=0
declare -a REPO_MIGRATIONS

# Function to extract migration ID from output
extract_migration_id() {
    grep -oP '\(ID: \K[^\)]+' || echo ""
}

# =========== Organization: Ambita ===========
echo "Starting migration of repositories from $GH_SOURCE_ORG to $GH_TARGET_ORG..."

# Get list of all repos
REPOS=$(GH_API=$GH_SOURCE_TOKEN gh api graphql --paginate -f query='
query($endCursor: String) {
  organization(login: "Ambita") {
    repositories(first: 100, after: $endCursor) {
      nodes {
        name
        visibility
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}' --jq '.data.organization.repositories.nodes[] | "\(.name)|\(.visibility)"')

GEI_PARM="--github-source-org $GH_SOURCE_ORG --github-source-pat $GH_SOURCE_PAT"
if [ -n "$GH_SOURCE_URL" ]; then
    GEI_PARM="${GEI_PARM} --source-api-url $GH_SOURCE_URL"
fi
GEI_PARM="${GEI_PARM} --github-target-org $GH_TARGET_ORG --github-target-pat $GH_TARGET_PAT"
if [ -n "$GH_TARGET_URL" ]; then
    GEI_PARM="${GEI_PARM} --target-api-url $GH_TARGET_URL"
fi

# Migrate each repository
while IFS='|' read -r REPO VISIBILITY; do
    echo "Migrating repository: $REPO (visibility: $VISIBILITY)"
    
    # Convert visibility to lowercase
    VISIBILITY_LOWER=$(echo "$VISIBILITY" | tr '[:upper:]' '[:lower:]')
    
    MIGRATION_ID=$(gh gei migrate-repo $GEI_PARM \
        --source-repo "$REPO" \
        --target-repo "$REPO" \
        --queue-only \
        --target-repo-visibility "$VISIBILITY_LOWER" 2>&1 | tee /dev/tty | extract_migration_id)
    
    if [ -n "$MIGRATION_ID" ]; then
        REPO_MIGRATIONS["$REPO"]="$MIGRATION_ID"
        echo "Queued migration for $REPO with ID: $MIGRATION_ID"
    else
        echo "Failed to queue migration for $REPO"
    fi
done <<< "$REPOS"

echo ""
echo "Migration queueing complete!"
echo "Use 'gh gei wait-for-migration' to monitor progress."
