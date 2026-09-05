import "dotenv/config";
import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { conectarBaseDatos } from "./infrastructure/db.js";
import { resolvers } from "./resolvers/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const typeDefs = readFileSync(path.join(__dirname, "schema.graphql"), "utf8");

await conectarBaseDatos();

const server = new ApolloServer({ typeDefs, resolvers });

const port = parseInt(process.env.PORT) || 4000;
const { url } = await startStandaloneServer(server, {
  listen: { port }
});

console.log(`Pide y Recoge levantado en: ${url}`);
