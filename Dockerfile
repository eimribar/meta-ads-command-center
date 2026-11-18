# Meta Ads Command Center in a container. This is one way to run it; `npm start` on any machine
# with Node 22 or newer works the same.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY db ./db
USER node
EXPOSE 3000
CMD ["node", "src/index.mjs"]
