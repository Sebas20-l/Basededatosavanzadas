// Conexion a Neo4j (grafo de permisos).
//
// Variables en .env:
//   NEO4J_URI       (por defecto bolt://localhost:7687, el contenedor de docker-compose)
//   NEO4J_USER      (por defecto neo4j)
//   NEO4J_PASSWORD  (obligatoria; la misma de NEO4J_AUTH en docker-compose.yml)

import neo4j from "neo4j-driver";

const uri = process.env.NEO4J_URI || "bolt://localhost:7687";
const usuario = process.env.NEO4J_USER || "neo4j";
const password = process.env.NEO4J_PASSWORD;

export const neo4jDriver = neo4j.driver(uri, neo4j.auth.basic(usuario, password ?? ""), {
  disableLosslessIntegers: true
});

export async function conectarNeo4j() {
  if (!password) {
    console.error("Falta NEO4J_PASSWORD en .env (la misma de NEO4J_AUTH en docker-compose.yml).");
    process.exit(1);
  }
  try {
    await neo4jDriver.verifyConnectivity();
    console.log("Neo4j conectado correctamente:", uri);
  } catch (error) {
    console.error("No se pudo conectar a Neo4j:", error.message);
    process.exit(1);
  }
}

export async function lecturaNeo4j(consulta, parametros = {}) {
  const sesion = neo4jDriver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const resultado = await sesion.executeRead(tx => tx.run(consulta, parametros));
    return resultado.records;
  } finally {
    await sesion.close();
  }
}

// Ejecuta varias consultas de escritura en UNA transaccion: o se aplican todas o ninguna.
export async function escrituraNeo4j(consultas) {
  const sesion = neo4jDriver.session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    await sesion.executeWrite(async tx => {
      for (const [consulta, parametros] of consultas) {
        await tx.run(consulta, parametros ?? {});
      }
    });
  } finally {
    await sesion.close();
  }
}
