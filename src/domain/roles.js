// Tipos de usuario de la plataforma multiempresa y las reglas sobre a que
// escuela, negocio o cafeteria debe estar ligado cada uno.

export const ROLES = Object.freeze({
  ADMIN_PLATAFORMA: "ADMIN_PLATAFORMA", // Equipo de CafeEnLinea: aprueba o suspende escuelas
  ADMIN_ESCUELA: "ADMIN_ESCUELA",       // Registra su escuela e invita a los negocios
  JEFE: "JEFE",                         // Dueno de un negocio con una o varias cafeterias
  VENDEDOR: "VENDEDOR",                 // Atiende pedidos y el menu de UNA cafeteria
  CLIENTE: "CLIENTE"                    // Comprador: solo ve el catalogo y pide
});

export const LISTA_ROLES = Object.values(ROLES);

// Regla de negocio: cada rol necesita ciertas ligas y no puede tener otras.
//   - Todos menos ADMIN_PLATAFORMA pertenecen a una escuela.
//   - JEFE y VENDEDOR pertenecen a un negocio.
//   - Solo VENDEDOR esta amarrado a una cafeteria.
export function validarLigasDeRol({ rol, escuelaId, negocioId, cafeteriaId }) {
  if (!LISTA_ROLES.includes(rol)) {
    throw new Error(`El rol "${rol}" no existe.`);
  }
  if (rol !== ROLES.ADMIN_PLATAFORMA && !escuelaId) {
    throw new Error(`Un usuario ${rol} debe pertenecer a una escuela.`);
  }
  const necesitaNegocio = rol === ROLES.JEFE || rol === ROLES.VENDEDOR;
  if (necesitaNegocio && !negocioId) {
    throw new Error(`Un usuario ${rol} debe pertenecer a un negocio.`);
  }
  if (!necesitaNegocio && negocioId) {
    throw new Error(`Un usuario ${rol} no puede pertenecer a un negocio.`);
  }
  if (rol === ROLES.VENDEDOR && !cafeteriaId) {
    throw new Error("Un vendedor debe estar asignado a una cafeteria.");
  }
  if (rol !== ROLES.VENDEDOR && cafeteriaId) {
    throw new Error(`Un usuario ${rol} no se asigna a una cafeteria.`);
  }
}
