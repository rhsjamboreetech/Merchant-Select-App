# Stage 1: Build
FROM node:20 AS builder

# Build-time environment variables for Vite
ARG VITE_SHEET_ID
ARG VITE_SHEET_TAB_NAME

# Make them available during build
ENV VITE_SHEET_ID=$VITE_SHEET_ID
ENV VITE_SHEET_TAB_NAME=$VITE_SHEET_TAB_NAME

WORKDIR /app

# Install deps (better caching)
COPY package*.json ./
COPY tsconfig.json ./
COPY vite.config.* ./
RUN npm install

# Copy rest of project
COPY . .

# Build frontend + backend
RUN npm run build

# ----------------------------

# Stage 2: Runtime
FROM node:20-slim

WORKDIR /app

# Copy built output
COPY --from=builder /app/dist ./dist
COPY package*.json ./

# Install only production deps
RUN npm install --omit=dev

ENV NODE_ENV=production

# 🔥 IMPORTANT: let platform control port
EXPOSE 8080

CMD ["node", "dist/index.js"]
