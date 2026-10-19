# Pide y Recoge

API GraphQL para pedir comida en la cafetería de la escuela y recogerla sin hacer fila.

- **MongoDB:** datos y reportes
- **Redis Stack:** caché y sesiones
- **Neo4j:** permisos RBAC

La documentación del Segundo Parcial está en [`docs/DOCUMENTACION.md`](docs/DOCUMENTACION.md).

## Cómo levantarlo

```bash
docker compose up -d     # bda-mongodb, bda-redis-stack, bda-neo4j
npm install
npm run seed             # catálogos + datos demo (usuario demo@ulsa.mx / demo123)
npm run dev              # http://localhost:4000
```

Para cargar el grafo de permisos en Neo4j:

```bash
docker exec -i bda-neo4j cypher-shell -u neo4j -p password123 < neo4j/rbac.cypher
```

> Si `docker compose up` falla con *"container name bda-... is already in use"*, ya tienes esos contenedores del docker-compose de la clase, con la misma configuración. Tienes dos opciones: arrancarlos con `docker start bda-mongodb bda-redis-stack bda-neo4j`, o borrarlos con `docker rm bda-mongodb bda-redis-stack bda-neo4j` y volver a correr `docker compose up -d`.

## Variables de entorno (`.env`, opcional)

| Variable | Default | Para qué |
|---|---|---|
| `MONGODB_URI` | `mongodb://admin:password123@localhost:27017/pide_y_recoge?authSource=admin` | Conexión a MongoDB. Pon aquí la de Atlas si quieres usar `crearPedido` (necesita replica set). |
| `REDIS_URL` | `redis://:password123@localhost:6379` | Conexión a Redis. |
| `JWT_SECRET` | secreto de desarrollo | Firma de los JWT. Cámbialo fuera de tu máquina. |
| `SESION_TTL_SEGUNDOS` | `3600` | Vida del token y de `sesion:<jti>` en Redis. |
| `CACHE_TTL_SEGUNDOS` | `60` | Vida de las claves `cache:*` en Redis. |
| `PORT` | `4000` | Puerto de la API. |

## Estructura

```
docker-compose.yml          topología: 3 contenedores en la red bda-network
neo4j/rbac.cypher           modelo RBAC: restricciones, datos y consultas de verificación
docs/DOCUMENTACION.md       documentación teórica + guía de la demo
src/
  index.js                  Apollo Server + middleware de contexto
  schema.graphql            SDL (queries y mutations)
  resolvers/index.js        resolvers, cache-aside, login/logout, agregación
  infrastructure/
    db.js                   conexión a MongoDB
    redis.js                cliente de Redis
    cache.js                patrón Cache-Aside y medición de latencias
    auth.js                 JWT + sesiones en Redis + contexto
    mongoose-models.js      esquemas de Mongoose
  domain/entities.js        reglas de negocio
```
