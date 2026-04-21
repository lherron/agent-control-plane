#!/usr/bin/env bash
# Create a thread and optionally send a message to it as the 'virtu' bot
# Usage: ./scripts/virtu-thread.sh --channel <id> --name "Thread Name" [--message "message text"]

set -euo pipefail

# Get virtu bot token from Consul
VIRTU_TOKEN=$(consul kv get cfg/dev/_global/discord/virtu_bot_token 2>/dev/null) || {
    echo "Error: Could not get virtu_bot_token from Consul" >&2
    exit 1
}

# Parse arguments
CHANNEL_ID=""
THREAD_NAME=""
MESSAGE=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --channel|-c)
            CHANNEL_ID="$2"
            shift 2
            ;;
        --name|-n)
            THREAD_NAME="$2"
            shift 2
            ;;
        --message|-m)
            MESSAGE="$2"
            shift 2
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

if [[ -z "$CHANNEL_ID" ]] || [[ -z "$THREAD_NAME" ]]; then
    echo "Usage: virtu-thread.sh --channel <id> --name <name> [--message <text>]" >&2
    exit 1
fi

# Create the thread
echo "Creating thread '$THREAD_NAME' in channel $CHANNEL_ID..." >&2
THREAD_RESULT=$(DISCORD_BOT_TOKEN="$VIRTU_TOKEN" discord-chat threads create \
    --channel-id "$CHANNEL_ID" \
    --name "$THREAD_NAME")

echo "$THREAD_RESULT"

# Extract thread ID
THREAD_ID=$(echo "$THREAD_RESULT" | jq -r '.data.id // empty')

if [[ -z "$THREAD_ID" ]]; then
    echo "Error: Failed to create thread" >&2
    exit 1
fi

echo "Thread created with ID: $THREAD_ID" >&2

# Send message to thread if provided
if [[ -n "$MESSAGE" ]]; then
    echo "Sending message to thread..." >&2
    DISCORD_BOT_TOKEN="$VIRTU_TOKEN" discord-chat messages send \
        --channel-id "$THREAD_ID" \
        --content "$MESSAGE"
fi
