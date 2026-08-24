FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
ENV PORT=3100
EXPOSE 3100
CMD ["node", "src/index.js"]
