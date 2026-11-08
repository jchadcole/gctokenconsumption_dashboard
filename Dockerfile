FROM node:22-alpine
ARG VERSION=dev
ARG BUILD_COMMIT=
ARG BUILD_DATE=
LABEL org.opencontainers.image.title="genesys-token-dashboard" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.source="https://github.com/jchadcole/gctokenconsumption_dashboard"
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=3000 BUILD_COMMIT=${BUILD_COMMIT} BUILD_DATE=${BUILD_DATE}
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
