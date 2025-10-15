FROM node:20-slim

# OS deps + pandoc + tectonic + qpdf
RUN apt-get update && apt-get install -y --no-install-recommends \
    pandoc qpdf curl ca-certificates \
    && curl -L https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-unknown-linux-gnu.tar.gz \
      | tar -xz -C /usr/local/bin --strip-components=1 tectonic-0.15.0-x86_64-unknown-linux-gnu/tectonic \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 8080
CMD ["npm","start"]
