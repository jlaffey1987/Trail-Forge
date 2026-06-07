FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
COPY dist/ ./dist/
COPY scripts/ ./scripts/
EXPOSE 8080
CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
