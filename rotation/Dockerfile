# Schlankes Image für die Reel-Rotation: Node + ffmpeg (zum Umrechnen auf Instagram-Format).
# node_modules kommen über das Bind-Mount ./rotation:/rotation.
FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /rotation
ENTRYPOINT ["node", "/rotation/rotate.mjs"]
