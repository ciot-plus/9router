# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS base
WORKDIR /app
# CN mirror for apk (used by runner stage)
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories

FROM base AS builder

# 原生依赖（@next/swc、@tailwindcss/oxide、lightningcss、better-sqlite3）
# 在 alpine/musl 下均有预编译二进制（prebuild），无需 python3/make/g++ 源码编译。
# better-sqlite3 走 prebuild-install 从 GitHub Releases 拉取 node-v127-linuxmusl-x64，
# 即使失败也仅是 optionalDependencies 告警，运行时由 node:sqlite / sql.js 兜底。
COPY package.json ./
RUN npm install --registry=https://npm-mirror.cnb.cool

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# FROM base 才能继承上面的 apk 镜像源（runner 阶段也需要 apk add）
FROM base AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="9router"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

# --chown 直接写属主，避免事后 chown -R 把产物再复制一层
COPY --chown=node:node --from=builder /app/public ./public
COPY --chown=node:node --from=builder /app/.next/static ./.next/static
COPY --chown=node:node --from=builder /app/.next/standalone ./
COPY --chown=node:node --from=builder /app/custom-server.js ./custom-server.js
COPY --chown=node:node --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --chown=node:node --from=builder /app/src/mitm ./src/mitm
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --chown=node:node --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --chown=node:node --from=builder /app/node_modules/next ./node_modules/next
# sql.js loads dist/sql-wasm.wasm by path at runtime; tracing only follows JS imports,
# so the last-resort DB driver would abort with ENOENT on the missing binary.
COPY --chown=node:node --from=builder /app/node_modules/sql.js ./node_modules/sql.js
# node-machine-id is createRequire-loaded at runtime; tracing omits it.
COPY --chown=node:node --from=builder /app/node_modules/node-machine-id ./node_modules/node-machine-id

# 只 chown 空的数据目录（产物属主已在 COPY 时设置）
RUN mkdir -p /app/data /app/data-home && \
  chown node:node /app/data /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

# Fix permissions at runtime (handles mounted volumes)
RUN apk --no-cache add su-exec && \
  printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
