# Use an official Node.js runtime as a parent image
FROM node:24.22.1-bookworm-slim

# Install build tools necessary for node-gyp
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    make \
    g++ \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g node-gyp

# Set the working directory
WORKDIR /app

# Copy dependency manifests and patches used by postinstall
COPY package*.json ./
COPY yarn.lock ./
COPY patches ./patches

# CPU binaries are bundled; do not download optional CUDA libraries.
ENV ONNXRUNTIME_NODE_INSTALL=skip

# Install dependencies. Package registries can return brief 5xx responses, so
# keep image builds resilient without hiding persistent failures.
RUN for attempt in 1 2 3; do \
      npx yarn install --frozen-lockfile --network-timeout 600000 && exit 0; \
      if [ "$attempt" -eq 3 ]; then exit 1; fi; \
      echo "Dependency installation failed on attempt $attempt. Retrying in 15 seconds."; \
      sleep 15; \
    done

# Copy the rest of the application code
COPY . .

# Build the project
RUN npx yarn build

# Expose the port the app runs on
EXPOSE 3000

# Command to run the application
CMD ["node", "dist/index.js"]
