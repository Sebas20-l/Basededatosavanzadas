// Queries del RBAC por rutas y del menu dinamico (Neo4j).
// Con sesion se usan los roles del usuario; sin sesion, el rol INVITADO.

import { rbacService } from "../services/rbac.service.js";

const usuarioDe = contexto => contexto.auth?.usuarioId ?? null;

export const resolversRbac = {
  Query: {
    miMenu: (_, __, contexto) => rbacService.obtenerMenuUsuario(usuarioDe(contexto)),

    puedoAcceder: (_, { path }, contexto) =>
      rbacService.validarAccesoRuta(usuarioDe(contexto), path),

    misRutas: (_, __, contexto) => rbacService.rutasPermitidas(usuarioDe(contexto))
  }
};
