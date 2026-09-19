FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Install CPU packages without optional lifecycle downloads. Project policy is retained.
RUN corepack pnpm install --frozen-lockfile
COPY lib ./lib
COPY services/analyzer ./services/analyzer
COPY tsconfig.json cloudflare-env.d.ts ./
RUN node services/analyzer/build.ts
# Bundle the pinned models in the image. Railway has no local .models mount.
RUN node services/analyzer/prepare-models.ts /opt/prizma/models

FROM node:24-bookworm-slim
ENV NODE_ENV=production
ENV MODEL_MANIFEST=/opt/prizma/models/manifest.json
ENV PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist-worker ./dist-worker
COPY --from=build /opt/prizma/models /opt/prizma/models
COPY package.json ./package.json
USER node
EXPOSE 8080
CMD ["node","dist-worker/services/analyzer/worker.js"]
