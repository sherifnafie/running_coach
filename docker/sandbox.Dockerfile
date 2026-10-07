# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash python3 python3-venv python3-pip sqlite3 git ffmpeg chromium ca-certificates libfaketime \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/coach-python \
    && /opt/coach-python/bin/pip install --no-cache-dir pandas numpy scipy matplotlib fitdecode gpxpy duckdb pillow
ENV PATH=/opt/coach-python/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /workspace
CMD ["sleep", "infinity"]
