# PayPilot: small production image. Data (SQLite) lives in /data; mount a volume to keep it.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=4s CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "server.js"]
