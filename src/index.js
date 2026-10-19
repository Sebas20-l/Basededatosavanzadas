import "dotenv/config";
import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { conectarBaseDatos } from "./infrastructure/db.js";
import { conectarRedis } from "./infrastructure/redis.js";
import { construirContexto } from "./infrastructure/auth.js";
import { resolvers } from "./resolvers/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const typeDefs = readFileSync(path.join(__dirname, "schema.graphql"), "utf8");

await conectarBaseDatos();
await conectarRedis();

const server = new ApolloServer({ typeDefs, resolvers });

const port = parseInt(process.env.PORT) || 4000;
const { url } = await startStandaloneServer(server, {
  listen: { port },
  // Middleware de contexto: valida la firma del JWT y que la sesion siga en Redis.
  // Si falla, la peticion se rechaza con 401 antes de llegar a los resolvers.
  context: construirContexto
});

console.log(`Pide y Recoge levantado en: ${url}`);
