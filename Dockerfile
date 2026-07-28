FROM node:20-slim

# ffmpeg is not included by default on most free hosts, so we install it here
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .

RUN mkdir -p /app/tmp /app/public/output

EXPOSE 3000
CMD ["node", "server.js"]
