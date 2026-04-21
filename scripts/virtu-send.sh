#!/usr/bin/env bash
# Send a message to Discord as the 'virtu' bot (virtual tester)
# Usage: ./scripts/virtu-send.sh "message text"
#        ./scripts/virtu-send.sh --channel <id> "message text"

set -euo pipefail

# Default channel: #rex
CP_CHANNEL_ID="${CP_CHANNEL_ID:?Error: CP_CHANNEL_ID must be set}"

# Get virtu bot token from Consul
VIRTU_TOKEN=$(consul kv get cfg/dev/_global/discord/virtu_bot_token 2>/dev/null) || {
    echo "Error: Could not get virtu_bot_token from Consul" >&2
    exit 1
}

# Parse arguments
CHANNEL_ID="$CP_CHANNEL_ID"
MESSAGE=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --channel|-c)
            CHANNEL_ID="$2"
            shift 2
            ;;
        *)
            MESSAGE="$1"
            shift
            ;;
    esac
done

if [[ -z "$MESSAGE" ]]; then
    echo "Usage: virtu-send.sh [--channel <id>] <message>" >&2
    echo "       Default channel: #rex ($CP_CHANNEL_ID)" >&2
    exit 1
fi

# Send message using discord-chat CLI with virtu bot token
DISCORD_BOT_TOKEN="$VIRTU_TOKEN" discord-chat messages send \
    --channel-id "$CHANNEL_ID" \
    --content "$MESSAGE"
