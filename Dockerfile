FROM node:26-bookworm-slim AS js
WORKDIR /app
RUN npm install -g pnpm@11.5.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/ apps/
COPY packages/ packages/
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
RUN pnpm build && pnpm install --prod --frozen-lockfile --force

FROM python:3.12-slim-bookworm
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim libgomp1 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv==0.11.17
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-cache
COPY --from=js /usr/local/bin/node /usr/local/bin/node
COPY --from=js /app/node_modules ./node_modules
COPY --from=js /app/dist ./dist
COPY package.json ./
COPY workers/ workers/
RUN useradd --create-home --uid 10001 lens && mkdir /data && chown lens /data
USER lens
ENV MEDIA_LENS_CACHE=/data/tasks HF_HOME=/data/models
ENTRYPOINT ["node","dist/apps/cli/main.js"]
CMD ["--help"]
