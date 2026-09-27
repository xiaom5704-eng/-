FROM node:24-bookworm-slim

WORKDIR /app

# 安裝編譯 better-sqlite3 可能需要的工具
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ libgomp1 ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

EXPOSE 3000

# 設定環境變數
ENV NODE_ENV=production

CMD ["npm", "start"]
