FROM node:20-slim

RUN apt-get update && apt-get install -y ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

RUN mkdir -p /app/tmp /app/public/output

EXPOSE 3000
CMD ["node", "server.js"]
