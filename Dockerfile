# syntax=docker/dockerfile:1.7
# BasaltNotes – ein Container: API, Web-Oberfläche, Kurator. Daten in /data.

# ---------- Build ----------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY packages/client/package.json packages/client/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY plugins/calendar/package.json plugins/calendar/
COPY plugins/dnd/package.json plugins/dnd/
RUN npm ci --no-audit --no-fund
COPY server server
COPY web web
COPY packages/plugin-sdk packages/plugin-sdk
COPY plugins plugins
RUN npm run build --workspace server && npm run build --workspace web && npm run build --workspace plugins/calendar && npm run build --workspace plugins/dnd

# ---------- Laufzeit ----------
FROM node:24-bookworm-slim
ARG VERSION=dev
LABEL org.opencontainers.image.title="BasaltNotes" \
      org.opencontainers.image.description="Self-hosted note-taking app with wiki links, backlinks and an optional AI curator" \
      org.opencontainers.image.source="https://github.com/Poldion/BasaltNotes" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"

RUN apt-get update \
 && apt-get install -y --no-install-recommends git tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # Volumes gehören oft einem anderen Benutzer (TrueNAS: apps 568) – git soll trotzdem arbeiten
 && git config --system --add safe.directory '*' \
 && git config --system init.defaultBranch main

WORKDIR /app
# PUID/PGID: Benutzer, unter dem die App läuft (TrueNAS „apps“ = 568). UMASK 002: Dateien sind für die Gruppe beschreibbar.
ENV NODE_ENV=production \
    PUID=568 \
    PGID=568 \
    UMASK=002 \
    DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0 \
    WEB_DIR=/app/web/dist \
    HOME=/tmp \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY packages/client/package.json packages/client/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY plugins/calendar/package.json plugins/calendar/
COPY plugins/dnd/package.json plugins/dnd/
RUN npm ci --omit=dev --no-audit --no-fund --workspace server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
# Mitgelieferte Plugins: nur Manifest und gebaute Dateien
COPY --from=build /app/plugins/calendar/manifest.json plugins/calendar/manifest.json
COPY --from=build /app/plugins/calendar/dist plugins/calendar/dist
COPY --from=build /app/plugins/dnd/manifest.json plugins/dnd/manifest.json
COPY --from=build /app/plugins/dnd/dist plugins/dnd/dist

COPY docker/entrypoint.sh /usr/local/bin/basalt-entrypoint
RUN chmod 755 /usr/local/bin/basalt-entrypoint \
 && mkdir -p /data/vaults \
 && chown -R 568:568 /data
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Startet als root, richtet die Rechte von /data und wechselt dann zu PUID:PGID
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/basalt-entrypoint"]
CMD ["node", "server/dist/index.js"]
