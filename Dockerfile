# Use an official Node.js runtime as a parent image
FROM node:24.15.0-alpine

# Install build tools necessary for node-gyp
RUN apk add --no-cache \
    python3 \
    py3-pip \
    make \
    g++ \
    ffmpeg \
    && npm install -g node-gyp

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./
COPY yarn.lock ./

# Install dependencies
RUN npx yarn install --frozen-lockfile

# Copy the rest of the application code
COPY . .

# Build the project
RUN npx yarn build

# Expose the port the app runs on
EXPOSE 3000

# Command to run the application
CMD ["npx", "yarn", "serve"]
