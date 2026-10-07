# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git python3 python3-venv python3-pip sqlite3 ffmpeg util-linux libcap2-bin chromium ca-certificates libfaketime \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/coach-python \
    && /opt/coach-python/bin/pip install --no-cache-dir pandas numpy scipy matplotlib fitdecode gpxpy duckdb pillow \
    && npm install --global pnpm@10.28.0
WORKDIR /app
COPY --chown=node:node . .
RUN --mount=type=cache,id=opencoach-pnpm-store,target=/pnpm/store \
    pnpm install --store-dir=/pnpm/store --package-import-method=copy --frozen-lockfile && pnpm build && mkdir -p /data && chown node:node /data
USER node
ENV OPENCOACH_DATA_DIR=/data OPENCOACH_CHROMIUM_PATH=/usr/bin/chromium
EXPOSE 8080 8081
CMD ["pnpm", "start"]
