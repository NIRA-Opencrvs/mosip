FROM node:23.1.0

WORKDIR /usr/src/app

# Install MinIO client
RUN curl -sSL https://dl.min.io/client/mc/release/linux-amd64/mc \
    -o /usr/local/bin/mc \
 && chmod +x /usr/local/bin/mc

COPY package.json yarn.lock tsconfig.json ./
RUN yarn install --production --frozen-lockfile

COPY src/ src/

CMD ["yarn", "start"]
