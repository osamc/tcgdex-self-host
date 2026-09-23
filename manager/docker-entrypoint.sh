#!/bin/sh
set -e
mkdir -p /data/cards /data/sets /data/series /data/images
chown -R node:node /data
exec su-exec node:node node src/server.js
