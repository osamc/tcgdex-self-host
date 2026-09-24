#!/bin/sh
set -e
mkdir -p /data/cards /data/sets /data/series /data/images
chown -R node:node /data
su-exec node:node node src/seed.js
exec su-exec node:node node src/server.js
