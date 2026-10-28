#!/bin/sh
# Startet BasaltNotes als PUID:PGID (Standard 568:568 = TrueNAS „apps“).
# Läuft der Container als root, werden vorher die Rechte von /data (inkl. eingehängter Vaults) gerichtet –
# so funktionieren Docker-Volumes, ixVolumes und Host-Pfade ohne manuelles chown.
set -e

PUID="${PUID:-568}"
PGID="${PGID:-568}"
umask "${UMASK:-002}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" "$DATA_DIR/vaults"
  # Nur Einträge mit falschem Besitzer anfassen (schnell bei großen Vaults)
  find "$DATA_DIR" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown "$PUID:$PGID" {} + 2>/dev/null || \
    echo "Hinweis: Rechte in $DATA_DIR konnten nicht vollständig gesetzt werden (z. B. ACL auf dem Dataset)." >&2
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups -- "$@"
fi

exec "$@"
