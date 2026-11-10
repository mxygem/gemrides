FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json server.js ./
EXPOSE 8080
CMD ["node", "server.js"]
