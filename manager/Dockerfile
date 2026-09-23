FROM node:22-alpine

RUN apk add --no-cache su-exec

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 8080

ENTRYPOINT ["/docker-entrypoint.sh"]
