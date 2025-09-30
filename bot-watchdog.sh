#!/bin/bash
# ============================================================
# Cryptoscanner Watchdog - cPanel safe version with worker.lock
# Run from cron every X minutes to ensure bot is alive
# ============================================================

APP_DIR="/home/steezepo/cryptoscanner"
NODE_ENV_DIR="/home/steezepo/nodevenv/cryptoscanner/20"
SCRIPT="$APP_DIR/build/main/index.js"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/cron.log"
LOCK_FILE="$APP_DIR/worker.lock"

mkdir -p "$LOG_DIR"

# Activate Node.js environment
source "$NODE_ENV_DIR/bin/activate"

# Check if worker.lock exists
if [ -f "$LOCK_FILE" ]; then
    BOT_PID=$(cat "$LOCK_FILE" 2>/dev/null)

    if [ -n "$BOT_PID" ] && kill -0 "$BOT_PID" 2>/dev/null; then
        echo "[$(date)] Bot is already running with PID $BOT_PID" | tee -a "$LOG_FILE"
        exit 0
    else
        echo "[$(date)] Found stale lock file (PID $BOT_PID), removing" | tee -a "$LOG_FILE"
        rm -f "$LOCK_FILE"
    fi
fi

# Start bot
echo "[$(date)] Bot not running, starting..." | tee -a "$LOG_FILE"
cd "$APP_DIR" || exit 1
node "$SCRIPT" >> "$LOG_FILE" 2>&1 &
NEW_PID=$!

# Write PID to worker.lock (so app + watchdog agree)
# echo $NEW_PID > "$LOCK_FILE"



# cron job script
# /bin/bash /home/steezepo/cryptoscanner/bot-watchdog.sh >> /home/steezepo/cryptoscanner/logs/cron-script.log 2>&1
