FROM node:22-alpine AS node
FROM docker:29-dind
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apk add --no-cache libstdc++ iproute2
