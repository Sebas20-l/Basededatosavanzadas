// Copia al grafo de Neo4j la estructura multiempresa que vive en MongoDB:
// quien es miembro de que escuela, quien es dueno de que negocio, donde
// trabaja cada vendedor y a que negocio y escuela pertenece cada cafeteria.
//
// MongoDB sigue siendo la fuente de verdad; Neo4j guarda solo las relaciones
// que hacen falta para responder "¿este usuario puede hacer X aqui?".
// Si el grafo se desincroniza, `npm run grafo` lo reconstruye desde MongoDB.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { escrituraNeo4j } from "./neo4j.js";
import { redisClient } from "./redis.js";
import {
  EscuelaModel,
  NegocioModel,
  CafeteriaModel,
  UsuarioModel
} from "./mongoose-models.js";
import { ROLES } from "../domain/roles.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO_RBAC = path.join(__dirname, "../../neo4j/rbac.cypher");

const id = valor => (valor == null ? null : String(valor));

// Borra los permisos cacheados de un usuario (ver autorizacion.js)
export async function invalidarPermisosUsuario(usuarioId) {
  const claves = [];
  for await (const lote of redisClient.scanIterator({ MATCH: `permiso:${usuarioId}:*`, COUNT: 100 })) {
    claves.push(...(Array.isArray(lote) ? lote : [lote]));
  }
  if (claves.length) {
    await redisClient.del(claves);
  }
}

export async function sincronizarEscuela(escuela) {
  await escrituraNeo4j([[
    `MERGE (e:Escuela {id: $id})
     SET e.clave = $clave, e.nombre = $nombre, e.ciudad = $ciudad`,
    { id: id(escuela._id), clave: escuela.clave, nombre: escuela.nombre, ciudad: escuela.ciudad ?? "" }
  ]]);
}

export async function sincronizarNegocio(negocio) {
  await escrituraNeo4j([[
    `MERGE (n:Negocio {id: $id})
     SET n.nombre = $nombre
     WITH n
     UNWIND $escuelaIds AS escuelaId
     MERGE (e:Escuela {id: escuelaId})
     MERGE (n)-[:OPERA_EN]->(e)`,
    { id: id(negocio._id), nombre: negocio.nombre, escuelaIds: (negocio.escuelaIds ?? []).map(id) }
  ]]);
}

export async function sincronizarCafeteria(cafeteria) {
  await escrituraNeo4j([[
    `MERGE (c:Cafeteria {id: $id})
     SET c.nombre = $nombre
     MERGE (e:Escuela {id: $escuelaId})
     MERGE (n:Negocio {id: $negocioId})
     MERGE (c)-[:PERTENECE_A]->(e)
     MERGE (n)-[:OPERA]->(c)`,
    {
      id: id(cafeteria._id),
      nombre: cafeteria.nombre,
      escuelaId: id(cafeteria.escuelaId),
      negocioId: id(cafeteria.negocioId)
    }
  ]]);
}

// Rehace todas las relaciones del usuario segun su rol actual
export async function sincronizarUsuario(usuario) {
  const parametros = {
    id: id(usuario._id),
    correo: usuario.correo,
    nombre: usuario.nombre,
    rol: usuario.rol,
    escuelaId: id(usuario.escuelaId),
    negocioId: id(usuario.negocioId),
    cafeteriaId: id(usuario.cafeteriaId)
  };

  const consultas = [
    [
      `MERGE (u:Usuario {id: $id})
       SET u.correo = $correo, u.nombre = $nombre
       WITH u
       OPTIONAL MATCH (u)-[r:TIENE_ROL|MIEMBRO_DE|ADMINISTRA|DUENO_DE|TRABAJA_EN]->()
       DELETE r`,
      parametros
    ],
    [
      `MATCH (u:Usuario {id: $id}), (rol:Rol {nombre: $rol})
       MERGE (u)-[:TIENE_ROL]->(rol)`,
      parametros
    ]
  ];

  if (parametros.escuelaId) {
    consultas.push([
      `MATCH (u:Usuario {id: $id})
       MERGE (e:Escuela {id: $escuelaId})
       MERGE (u)-[:MIEMBRO_DE]->(e)`,
      parametros
    ]);
  }
  if (usuario.rol === ROLES.ADMIN_ESCUELA) {
    consultas.push([
      `MATCH (u:Usuario {id: $id}), (e:Escuela {id: $escuelaId})
       MERGE (u)-[:ADMINISTRA]->(e)`,
      parametros
    ]);
  }
  if (usuario.rol === ROLES.JEFE) {
    consultas.push([
      `MATCH (u:Usuario {id: $id})
       MERGE (n:Negocio {id: $negocioId})
       MERGE (u)-[:DUENO_DE]->(n)`,
      parametros
    ]);
  }
  if (usuario.rol === ROLES.VENDEDOR) {
    consultas.push([
      `MATCH (u:Usuario {id: $id})
       MERGE (c:Cafeteria {id: $cafeteriaId})
       MERGE (u)-[:TRABAJA_EN]->(c)`,
      parametros
    ]);
  }

  await escrituraNeo4j(consultas);
  await invalidarPermisosUsuario(parametros.id);
}

// Sentencias del modelo RBAC (roles, permisos, restricciones) de rbac.cypher,
// sin las consultas de verificacion del final ni las lineas de comentario.
function sentenciasRbac() {
  const contenido = readFileSync(ARCHIVO_RBAC, "utf8").split("CONSULTAS DE VERIFICACION")[0];
  return contenido
    .split(/;\s*(?:\r?\n|$)/)
    .map(bloque => bloque.split(/\r?\n/).filter(l => !l.trim().startsWith("//")).join("\n").trim())
    .filter(Boolean);
}

// Reconstruye el grafo completo: modelo RBAC + todo lo que hay en MongoDB.
export async function reconstruirGrafo() {
  // Las restricciones (CREATE CONSTRAINT) no pueden ir en la misma transaccion
  // que escrituras de datos: se ejecuta cada sentencia por separado.
  for (const sentencia of sentenciasRbac()) {
    await escrituraNeo4j([[sentencia]]);
  }

  const [escuelas, negocios, cafeterias, usuarios] = await Promise.all([
    EscuelaModel.find({}),
    NegocioModel.find({}),
    CafeteriaModel.find({}),
    UsuarioModel.find({})
  ]);
  for (const escuela of escuelas) await sincronizarEscuela(escuela);
  for (const negocio of negocios) await sincronizarNegocio(negocio);
  for (const cafeteria of cafeterias) await sincronizarCafeteria(cafeteria);
  for (const usuario of usuarios) await sincronizarUsuario(usuario);

  return {
    escuelas: escuelas.length,
    negocios: negocios.length,
    cafeterias: cafeterias.length,
    usuarios: usuarios.length
  };
}

// Para llamar despues de guardar en MongoDB: si Neo4j falla, el dato ya quedo
// guardado; se avisa en consola para reconstruir el grafo con `npm run grafo`.
export async function sincronizarSinFallar(descripcion, fn) {
  try {
    await fn();
  } catch (error) {
    console.error(
      `[GRAFO] No se pudo sincronizar ${descripcion} con Neo4j: ${error.message}. ` +
      "Corre `npm run grafo` para reconstruir el grafo."
    );
  }
}
