// Autorizacion: ¿este usuario puede hacer ESTA accion sobre ESTA escuela,
// negocio o cafeteria?
//
// Uso en un resolver:
//   await autorizar(contexto, "PRODUCTO_GESTIONAR", { cafeteriaId });
//
// Cada permiso tiene un "alcance":
//   COMPRA     -> basta con ser miembro de la escuela (comprar en sus cafeterias)
//   GESTION    -> hay que trabajar en la cafeteria, ser dueno del negocio o
//                 administrar la escuela
//   PLATAFORMA -> solo el equipo de CafeEnLinea

import { prohibido, requerirSesion } from "./auth.js";
import { UsuarioModel, CafeteriaModel } from "./mongoose-models.js";
import { ROLES } from "../domain/roles.js";

const ALCANCE = {
  PEDIDO_CREAR: "COMPRA",
  PEDIDO_LEER_PROPIOS: "COMPRA",
  PEDIDO_CANCELAR_PROPIO: "COMPRA",
  PEDIDO_LEER_CAFETERIA: "GESTION",
  PEDIDO_CAMBIAR_ESTADO: "GESTION",
  INVENTARIO_REPONER: "GESTION",
  PRODUCTO_GESTIONAR: "GESTION",
  VENDEDOR_REGISTRAR: "GESTION",
  CAFETERIA_REGISTRAR: "GESTION",
  NEGOCIO_ADMINISTRAR: "GESTION",
  REPORTE_VENTAS_LEER: "GESTION",
  ESCUELA_ADMINISTRAR: "GESTION",
  REPORTE_ESCUELA_LEER: "GESTION",
  PLATAFORMA_ADMINISTRAR: "PLATAFORMA"
};

// Permisos directos de cada rol y de quien hereda (JEFE > VENDEDOR > CLIENTE)
const ROL = {
  CLIENTE: { hereda: [], permisos: ["PEDIDO_CREAR", "PEDIDO_LEER_PROPIOS", "PEDIDO_CANCELAR_PROPIO"] },
  VENDEDOR: {
    hereda: ["CLIENTE"],
    permisos: ["PEDIDO_LEER_CAFETERIA", "PEDIDO_CAMBIAR_ESTADO", "INVENTARIO_REPONER", "PRODUCTO_GESTIONAR"]
  },
  JEFE: {
    hereda: ["VENDEDOR"],
    permisos: ["VENDEDOR_REGISTRAR", "CAFETERIA_REGISTRAR", "NEGOCIO_ADMINISTRAR", "REPORTE_VENTAS_LEER"]
  },
  ADMIN_ESCUELA: { hereda: [], permisos: ["ESCUELA_ADMINISTRAR", "REPORTE_ESCUELA_LEER"] },
  ADMIN_PLATAFORMA: { hereda: ["ADMIN_ESCUELA"], permisos: ["PLATAFORMA_ADMINISTRAR"] }
};

function permisosDeRol(rol) {
  const definicion = ROL[rol];
  if (!definicion) return new Set();
  const permisos = new Set(definicion.permisos);
  for (const padre of definicion.hereda) {
    permisosDeRol(padre).forEach(p => permisos.add(p));
  }
  return permisos;
}

const mismoId = (a, b) => a != null && b != null && String(a) === String(b);

export async function puede(usuarioId, permiso, { cafeteriaId, escuelaId, negocioId } = {}) {
  const usuario = await UsuarioModel.findById(usuarioId).lean();
  if (!usuario || !permisosDeRol(usuario.rol).has(permiso)) return false;
  if (usuario.rol === ROLES.ADMIN_PLATAFORMA) return true;
  if (!cafeteriaId && !escuelaId && !negocioId) return true;

  let cafeteria = null;
  if (cafeteriaId) {
    cafeteria = await CafeteriaModel.findById(cafeteriaId).lean();
    if (!cafeteria) return false;
  }

  if (ALCANCE[permiso] === "COMPRA") {
    return mismoId(usuario.escuelaId, cafeteria ? cafeteria.escuelaId : escuelaId);
  }

  // GESTION
  const esJefe = usuario.rol === ROLES.JEFE;
  const esAdminEscuela = usuario.rol === ROLES.ADMIN_ESCUELA;
  if (cafeteria) {
    return (
      mismoId(usuario.cafeteriaId, cafeteria._id) ||
      (esJefe && mismoId(usuario.negocioId, cafeteria.negocioId)) ||
      (esAdminEscuela && mismoId(usuario.escuelaId, cafeteria.escuelaId))
    );
  }
  if (negocioId) return esJefe && mismoId(usuario.negocioId, negocioId);
  return esAdminEscuela && mismoId(usuario.escuelaId, escuelaId);
}

// Lanza 401 si no hay sesion y 403 si no tiene permiso. Devuelve los datos de la sesion.
export async function autorizar(contexto, permiso, alcance = {}) {
  const auth = requerirSesion(contexto);
  if (!(await puede(auth.usuarioId, permiso, alcance))) {
    throw prohibido(`No tienes permiso para ${permiso} en este recurso.`);
  }
  return auth;
}
