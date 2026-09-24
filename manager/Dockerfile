FROM node:22-alpine

RUN apk add --no-cache su-exec

WORKDIR /app

COPY manager/package.json manager/package-lock.json ./
RUN npm ci --omit=dev
COPY manager/src ./src
COPY manager/public ./public
COPY examples ./seed
COPY manager/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 8080

ENTRYPOINT ["/docker-entrypoint.sh"]
