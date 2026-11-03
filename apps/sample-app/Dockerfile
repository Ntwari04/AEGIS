FROM node:22-alpine
WORKDIR /app
COPY server.js health.flag ./
# Test hook: build with --build-arg HEALTH_OVERRIDE=broken to bake in a failing health check.
ARG HEALTH_OVERRIDE=
ENV HEALTH_OVERRIDE=${HEALTH_OVERRIDE}
USER node
EXPOSE 3000
CMD ["node", "server.js"]
