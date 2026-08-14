FROM node:22-bookworm-slim



RUN apt-get update \

  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \

  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \

    | gpg --dearmor -o /usr/share/keyrings/postgresql-pgdg.gpg \

  && echo "deb [signed-by=/usr/share/keyrings/postgresql-pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \

    > /etc/apt/sources.list.d/pgdg.list \

  && apt-get update \

  && apt-get install -y --no-install-recommends postgresql-client-18 \

  && rm -rf /var/lib/apt/lists/*



WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN corepack enable && pnpm install --frozen-lockfile

COPY . .

RUN pnpm build



CMD ["node", "--enable-source-maps", "dist-server/backup-worker.js"]

