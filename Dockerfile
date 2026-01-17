FROM node:20-alpine AS base
WORKDIR /app

COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* ./
COPY patches ./patches

# Install all dependencies including devDependencies (needed for TypeScript build)
RUN npm ci || npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
# Install wireguard and networking tools. openresolv provides resolvconf for DNS updates.
# The symlink ensures resolvconf is found in /sbin which some tools expect.
# Using ln -sf to force symlink creation; errors are suppressed since the target
# may already exist or the source may not be present (both are acceptable states).
RUN apk add --no-cache wireguard-tools openvpn iproute2 iptables openresolv \
    && ln -sf /usr/sbin/resolvconf /sbin/resolvconf 2>/dev/null || true
ENV NODE_ENV=production
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/dist ./dist
COPY package.json ./package.json

CMD ["node", "dist/app/main.js"]
