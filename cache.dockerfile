# syntax=docker/dockerfile:1.7
# 用于 docker:cache 内置任务构建依赖缓存镜像。
# 分层须与主 Dockerfile 的 builder 阶段（apk 镜像源 + 依赖安装）保持完全一致，
# 这样 docker build --cache-from 才能命中缓存，避免重复下载依赖。
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS cache
WORKDIR /app
# CN mirror for apk（与主 Dockerfile base 阶段一致）
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories
COPY package.json ./
# 与主 Dockerfile builder 阶段一致（原生依赖均为 musl prebuilt，无需编译工具）
RUN npm install --registry=https://npm-mirror.cnb.cool
# 设置缓存环境变量，供后续任务复用
ENV NODE_PATH=/app/node_modules
