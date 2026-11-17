# API (Apollo Server) en Linux: el driver oficial de ScyllaDB (@scylladb/driver)
# solo trae binarios para Linux, asi que la API no corre directo en Windows.
FROM node:24-slim

WORKDIR /app

# El binario nativo del driver de ScyllaDB necesita OpenSSL 3 (libssl.so.3),
# que la imagen slim no trae
RUN apt-get update \
 && apt-get install -y --no-install-recommends libssl3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Primero las dependencias, para que Docker las reutilice si solo cambia el codigo
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY neo4j ./neo4j

EXPOSE 4000
CMD ["node", "src/index.js"]
