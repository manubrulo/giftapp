FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --from=build /app/src/server src/server
COPY package.json .
VOLUME /data
EXPOSE 3000
CMD ["node_modules/.bin/tsx", "src/server/index.ts"]
