# Stage 1: Build Rust binary
FROM rust:alpine AS rust-builder
WORKDIR /rust-build
RUN apk add --no-cache musl-dev openssl-dev openssl-libs-static pkgconfig

COPY rust-clob-bridge/Cargo.toml rust-clob-bridge/Cargo.lock* ./
COPY rust-clob-bridge/src ./src

# Build in release mode with static linking
ENV OPENSSL_STATIC=1
ENV OPENSSL_LIB_DIR=/usr/lib
ENV OPENSSL_INCLUDE_DIR=/usr/include
RUN cargo build --release

# Stage 2: Build Node.js app
FROM node:20-alpine AS base
WORKDIR /app

COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* ./
COPY patches ./patches

# Install all dependencies including devDependencies (needed for TypeScript build)
RUN npm ci || npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 3: Final image
FROM node:20-alpine
WORKDIR /app
# Install wireguard and networking tools. openresolv provides resolvconf for DNS updates.
# The symlink ensures resolvconf is found in /sbin which some tools expect.
# Using ln -sf to force symlink creation; errors are suppressed since the target
# may already exist or the source may not be present (both are acceptable states).
RUN apk add --no-cache wireguard-tools openvpn iproute2 iptables openresolv libgcc \
    && ln -sf /usr/sbin/resolvconf /sbin/resolvconf 2>/dev/null || true
ENV NODE_ENV=production

# Copy Rust binary
COPY --from=rust-builder /rust-build/target/release/polymarket-bridge /app/bin/polymarket-bridge

# Copy Node.js app
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/dist ./dist
COPY package.json ./package.json

CMD ["node", "dist/app/main.js"]
