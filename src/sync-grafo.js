// Reconstruye el grafo de permisos en Neo4j desde MongoDB.
//
//   npm run grafo
//
// 1. Carga el modelo RBAC de neo4j/rbac.cypher (roles, permisos, restricciones).
// 2. Copia escuelas, negocios, cafeterias y usuarios con sus relaciones.
// Es repetible: usa MERGE, asi que correrlo dos veces no duplica nada.

import "dotenv/config";
import mongoose from "mongoose";
import { conectarBaseDatos } from "./infrastructure/db.js";
import { redisClient, conectarRedis } from "./infrastructure/redis.js";
import { neo4jDriver, conectarNeo4j } from "./infrastructure/neo4j.js";
import { reconstruirGrafo } from "./infrastructure/grafo.js";

await conectarBaseDatos();
await conectarRedis();
await conectarNeo4j();

const resumen = await reconstruirGrafo();
console.log("Grafo de permisos reconstruido:", resumen);

await neo4jDriver.close();
await redisClient.quit();
await mongoose.disconnect();
