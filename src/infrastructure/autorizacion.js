// Autorizacion con Neo4j: ¿este usuario puede hacer ESTA accion sobre ESTA
// escuela, negocio o cafeteria?
//
// Uso en un resolver:
//   await autorizar(contexto, "PRODUCTO_GESTIONAR", { cafeteriaId });
//
// La respuesta sale de recorrer el grafo (ver neo4j/rbac.cypher):
//   1. ¿Alguno de sus roles (o los que hereda) tiene ese permiso?
//   2. ¿Llega al recurso por el camino que pide el alcance del permiso?
//        COMPRA     -> (u)-[:MIEMBRO_DE]->(escuela)<-[:PERTENECE_A]-(cafeteria)
//        GESTION    -> (u)-[:TRABAJA_EN]->(cafeteria)
//                      (u)-[:DUENO_DE]->(negocio)-[:OPERA]->(cafeteria)
//                      (u)-[:ADMINISTRA]->(escuela)<-[:PERTENECE_A]-(cafeteria)
//        PLATAFORMA -> solo ADMIN_PLATAFORMA
//
// Cada respuesta se guarda en Redis unos minutos (cache-aside), para no
// consultar Neo4j en cada peticion. Al cambiar las relaciones de un usuario
// se borran sus respuestas guardadas (grafo.js -> invalidarPermisosUsuario).

import { prohibido, requerirSesion } from "./auth.js";
import { lecturaNeo4j } from "./neo4j.js";
import { redisClient } from "./redis.js";

const PERMISO_TTL_SEGUNDOS = parseInt(process.env.PERMISO_TTL_SEGUNDOS) || 300;

const CONSULTA_PERMISO = `
MATCH (u:Usuario {id: $usuarioId})
OPTIONAL MATCH (u)-[:TIENE_ROL]->(:Rol)-[:HEREDA_DE*0..]->(:Rol)-[:TIENE_PERMISO]->(p:Permiso {clave: $permiso})
WITH u, collect(DISTINCT p.alcance) AS alcances
WHERE size(alcances) > 0
RETURN
  EXISTS { (u)-[:TIENE_ROL]->(:Rol {nombre: "ADMIN_PLATAFORMA"}) }
  OR ($cafeteriaId IS NULL AND $escuelaId IS NULL AND $negocioId IS NULL)
  OR ("COMPRA" IN alcances AND (
        EXISTS { (u)-[:MIEMBRO_DE]->(:Escuela)<-[:PERTENECE_A]-(:Cafeteria {id: $cafeteriaId}) }
     OR EXISTS { (u)-[:MIEMBRO_DE]->(:Escuela {id: $escuelaId}) }
  ))
  OR ("GESTION" IN alcances AND (
        EXISTS { (u)-[:TRABAJA_EN]->(:Cafeteria {id: $cafeteriaId}) }
     OR EXISTS { (u)-[:DUENO_DE]->(:Negocio)-[:OPERA]->(:Cafeteria {id: $cafeteriaId}) }
     OR EXISTS { (u)-[:DUENO_DE]->(:Negocio {id: $negocioId}) }
     OR EXISTS { (u)-[:ADMINISTRA]->(:Escuela)<-[:PERTENECE_A]-(:Cafeteria {id: $cafeteriaId}) }
     OR EXISTS { (u)-[:ADMINISTRA]->(:Escuela {id: $escuelaId}) }
  ))
  AS autorizado
`;

const texto = valor => (valor == null ? null : String(valor));

function claveCache(usuarioId, permiso, { cafeteriaId, escuelaId, negocioId }) {
  const alcance = cafeteriaId ? `c:${cafeteriaId}` : negocioId ? `n:${negocioId}` : escuelaId ? `e:${escuelaId}` : "-";
  return `permiso:${usuarioId}:${permiso}:${alcance}`;
}

export async function puede(usuarioId, permiso, alcance = {}) {
  const parametros = {
    usuarioId: texto(usuarioId),
    permiso,
    cafeteriaId: texto(alcance.cafeteriaId),
    escuelaId: texto(alcance.escuelaId),
    negocioId: texto(alcance.negocioId)
  };
  const clave = claveCache(parametros.usuarioId, permiso, parametros);

  const enCache = await redisClient.get(clave);
  if (enCache !== null) {
    return enCache === "1";
  }

  const registros = await lecturaNeo4j(CONSULTA_PERMISO, parametros);
  const autorizado = registros.length > 0 && registros[0].get("autorizado") === true;

  await redisClient.set(clave, autorizado ? "1" : "0", { EX: PERMISO_TTL_SEGUNDOS });
  console.log(`[PERMISO] ${permiso} usuario=${parametros.usuarioId} -> ${autorizado ? "SI" : "NO"} (Neo4j)`);
  return autorizado;
}

// Lanza 401 si no hay sesion y 403 si no tiene permiso. Devuelve los datos de la sesion.
export async function autorizar(contexto, permiso, alcance = {}) {
  const auth = requerirSesion(contexto);
  if (!(await puede(auth.usuarioId, permiso, alcance))) {
    throw prohibido(`No tienes permiso para ${permiso} en este recurso.`);
  }
  return auth;
}
