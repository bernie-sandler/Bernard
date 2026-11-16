#!/bin/sh
# Runs the app as PUID:PGID with UMASK, after making sure that user owns /data.
# Started as root (the default), it fixes ownership and drops privileges.
# Started as a non-root user (docker run --user), it just runs the app as that user.
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
UMASK="${UMASK:-0022}"
DATA_DIR="$(dirname "${DATABASE_PATH:-/data/bernard.db}")"

case "$PUID" in '' | *[!0-9]*) echo "PUID must be a number, got '$PUID'" >&2; exit 1 ;; esac
case "$PGID" in '' | *[!0-9]*) echo "PGID must be a number, got '$PGID'" >&2; exit 1 ;; esac
case "$UMASK" in '' | *[!0-7]*) echo "UMASK must be octal (e.g. 0022), got '$UMASK'" >&2; exit 1 ;; esac

umask "$UMASK"

if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

if [ "$PUID" = "0" ]; then
  echo "Warning: PUID=0 runs Bernard as root." >&2
fi

mkdir -p "$DATA_DIR"
# Only touch files with the wrong owner, so restarts stay fast.
find "$DATA_DIR" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown "$PUID:$PGID" {} +

export HOME=/tmp
exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups -- "$@"
