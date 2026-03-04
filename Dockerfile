FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY prisma ./prisma

RUN npx prisma generate

# prod 
FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/generated ./generated
COPY package*.json ./

COPY index.js .
COPY newrelic.js .
COPY consumer ./consumer
COPY lib ./lib
COPY prisma ./prisma


CMD ["node", "-r", "newrelic", "index.js"]
