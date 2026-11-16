// Servicio de seguridad: RBAC por rutas y menu dinamico con Neo4j.
//
// El modelo esta en neo4j/init-rbac.cql:
//   (:User)-[:HAS_ROLE]->(:Role)-[:INHERITS*0..]->(:Role)-[:CAN_ACCESS]->(:Route)
//                                                (:Role)-[:CAN_VIEW_MENU]->(:MenuNode)
//
// [:INHERITS*0..] = "el rol mismo (0 saltos) o cualquiera que herede, a cualquier
// profundidad". Por eso cada ruta se liga solo al rol mas bajo que la usa.
//
// Sin sesion se usa el rol INVITADO.

import neo4j from "neo4j-driver";
import { getDriver } from "../infrastructure/neo4j.js";

export const ROL_INVITADO = "INVITADO";

// De donde salen los roles del que pregunta: los de su usuario, o INVITADO.
const rolesDe = userId =>
  userId
    ? "MATCH (u:User {id: $userId})-[:HAS_ROLE]->(r:Role)"
    : `MATCH (r:Role {name: "${ROL_INVITADO}"})`;

const aEntero = valor => (neo4j.isInt(valor) ? valor.toNumber() : valor);

async function leer(cypher, parametros) {
  // Sesion de solo lectura: el driver puede mandarla a una replica
  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    return (await session.run(cypher, parametros)).records;
  } finally {
    await session.close();
  }
}

export const rbacService = {
  // 1. ¿Puede entrar a esta ruta? Recorre la herencia con longitud variable.
  async validarAccesoRuta(userId, path) {
    const cypher = `
      ${rolesDe(userId)}
      MATCH (r)-[:INHERITS*0..]->(effectiveRole:Role)-[:CAN_ACCESS]->(rt:Route {path: $path})
      RETURN count(rt) > 0 AS autorizado
    `;
    const registros = await leer(cypher, { userId: userId ?? null, path });
    return registros[0]?.get("autorizado") ?? false;
  },

  // Todas las rutas que puede abrir (propias + heredadas)
  async rutasPermitidas(userId) {
    const cypher = `
      ${rolesDe(userId)}
      MATCH (r)-[:INHERITS*0..]->(:Role)-[:CAN_ACCESS]->(rt:Route)
      RETURN DISTINCT rt.path AS path
      ORDER BY path
    `;
    const registros = await leer(cypher, { userId: userId ?? null });
    return registros.map(registro => registro.get("path"));
  },

  // 2. Menu del usuario: menus raiz que puede ver, con sus submenus permitidos.
  //
  // Diferencia con la consulta de la actividad: alli un hijo solo aparece si lo
  // otorga EL MISMO rol que otorgo al padre. Si "Menu de la cafeteria" es de
  // VENDEDOR y su hijo "Mas vendidos" es de JEFE, el JEFE (que hereda ambos)
  // no veria el hijo. Aqui primero se juntan TODOS los roles efectivos y los
  // hijos se filtran contra ese conjunto.
  async obtenerMenuUsuario(userId) {
    const cypher = `
      ${rolesDe(userId)}
      MATCH (r)-[:INHERITS*0..]->(effectiveRole:Role)
      WITH collect(DISTINCT effectiveRole) AS roles

      UNWIND roles AS rol
      MATCH (rol)-[:CAN_VIEW_MENU]->(parent:MenuNode)
      WHERE NOT ()-[:HAS_CHILD]->(parent)
      WITH DISTINCT parent, roles

      OPTIONAL MATCH (parent)-[:NAVIGATES_TO]->(rtParent:Route)
      OPTIONAL MATCH (parent)-[:HAS_CHILD]->(child:MenuNode)
        WHERE EXISTS { MATCH (permitido:Role)-[:CAN_VIEW_MENU]->(child) WHERE permitido IN roles }
      OPTIONAL MATCH (child)-[:NAVIGATES_TO]->(rtChild:Route)
      WITH parent, rtParent, child, rtChild
      ORDER BY child.order ASC

      RETURN parent.id AS id, parent.title AS title, parent.order AS order, rtParent.path AS path,
             collect(DISTINCT CASE WHEN child IS NOT NULL THEN {
               id: child.id,
               title: child.title,
               order: child.order,
               path: rtChild.path
             } END) AS children
      ORDER BY order ASC
    `;
    const registros = await leer(cypher, { userId: userId ?? null });
    return registros.map(registro => ({
      id: registro.get("id"),
      title: registro.get("title"),
      order: aEntero(registro.get("order")),
      path: registro.get("path"),
      children: registro
        .get("children")
        .filter(Boolean)
        .map(hijo => ({ ...hijo, order: aEntero(hijo.order), children: [] }))
    }));
  }
};
