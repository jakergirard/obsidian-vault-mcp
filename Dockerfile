FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ripgrep oathtool tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh

# obsidian-headless is NOT bundled (its npm package is UNLICENSED, so the end
# user fetches it from npm on first start). NPM_CONFIG_PREFIX points at /data
# so the install persists across container recreation.
ENV HOME=/data \
    NPM_CONFIG_PREFIX=/data/npm \
    PATH=/data/npm/bin:$PATH \
    VAULT_DIR=/vault \
    DATA_DIR=/data \
    PORT=3000

EXPOSE 3000
VOLUME ["/vault", "/data"]

ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
