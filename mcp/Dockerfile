FROM oven/bun:1.2-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY worker.ts serve.ts tsconfig.json ./

EXPOSE 8787

CMD ["bun", "run", "serve.ts"]
