# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS builder
WORKDIR /app

RUN node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 22)) throw new Error('PatchPaw images require Node.js >=22.22.0')"

COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
COPY scripts ./scripts
COPY operation ./operation
COPY skills ./skills
COPY web ./web
COPY tsconfig.json ./

RUN npm run build \
  && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime

RUN node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 22)) throw new Error('PatchPaw images require Node.js >=22.22.0')"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 patchpaw \
  && useradd --uid 10001 --gid 10001 --create-home --shell /bin/sh patchpaw \
  && mkdir -p /var/lib/patchpaw \
  && chown -R patchpaw:patchpaw /var/lib/patchpaw /home/patchpaw

WORKDIR /app

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=patchpaw:patchpaw /app/node_modules ./node_modules
COPY --from=builder --chown=patchpaw:patchpaw /app/src ./src
COPY --from=builder --chown=patchpaw:patchpaw /app/scripts ./scripts
COPY --from=builder --chown=patchpaw:patchpaw /app/operation ./operation
COPY --from=builder --chown=patchpaw:patchpaw /app/skills ./skills
COPY --from=builder --chown=patchpaw:patchpaw /app/web/dist ./web/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PATCHPAW_HOME=/var/lib/patchpaw \
    PATCHPAW_LISTEN_HOST=0.0.0.0 \
    HOME=/home/patchpaw

VOLUME ["/var/lib/patchpaw"]
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PATCHPAW_PORT || '3000') + '/health').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "src/index.ts"]
