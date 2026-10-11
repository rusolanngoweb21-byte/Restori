# Reuse the already built, verified CPU model image. No new model downloads or installs.
FROM prizma-analyzer:local AS build
USER root
WORKDIR /app
COPY lib ./lib
COPY app ./app
COPY components ./components
COPY vendor ./vendor
COPY public ./public
COPY services/web ./services/web
COPY services/analyzer ./services/analyzer
COPY drizzle ./drizzle
COPY tsconfig.json cloudflare-env.d.ts postcss.config.mjs ./
RUN node node_modules/typescript/bin/tsc -p services/web/tsconfig.json --noEmit
RUN node services/analyzer/build.ts
RUN node node_modules/vite/bin/vite.js build --config services/web/vite.config.ts

FROM prizma-analyzer:local
WORKDIR /app
COPY --from=build /app/dist-web ./dist-web
COPY --from=build /app/dist-worker ./dist-worker
COPY --from=build /app/services/web/*.ts ./services/web/
COPY --from=build /app/lib ./lib
COPY --from=build /app/drizzle ./drizzle
USER node
ENV NODE_OPTIONS=--max-old-space-size=256
EXPOSE 3000 8081
CMD ["node", "services/web/main.ts"]
