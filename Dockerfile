FROM oven/bun:1.3.5

WORKDIR /app

COPY package.json tsconfig.json ./
RUN bun install

COPY src ./src
COPY .env.example ./

CMD ["bun", "run", "src/index.ts"]
