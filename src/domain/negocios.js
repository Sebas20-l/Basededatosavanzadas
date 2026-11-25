// Alta de cafeterias por su dueno (JEFE): el negocio se registra solo desde la
// app y queda en revision hasta que el equipo de la plataforma cierra el trato
// y lo aprueba. La escuela solo da permiso de vender, fuera de la app.

export const ESTADOS_NEGOCIO = {
  EN_REVISION: "EN_REVISION",
  APROBADO: "APROBADO",
  RECHAZADO: "RECHAZADO"
};

export const LISTA_ESTADOS_NEGOCIO = Object.values(ESTADOS_NEGOCIO);

export const MOTIVO_RECHAZO_MAX = 300;

// A que estados se puede pasar desde cada uno:
//   EN_REVISION -> APROBADO | RECHAZADO
//   RECHAZADO   -> APROBADO               (se reconsidera)
//   APROBADO    -> RECHAZADO              (se da de baja, ej. termino el trato)
const TRANSICIONES = {
  EN_REVISION: [ESTADOS_NEGOCIO.APROBADO, ESTADOS_NEGOCIO.RECHAZADO],
  RECHAZADO: [ESTADOS_NEGOCIO.APROBADO],
  APROBADO: [ESTADOS_NEGOCIO.RECHAZADO]
};

// Lanza un Error con mensaje para la app si el cambio no se permite.
export function validarCambioEstadoNegocio(actual, nuevo) {
  const desde = actual ?? ESTADOS_NEGOCIO.APROBADO;
  if (!LISTA_ESTADOS_NEGOCIO.includes(nuevo)) {
    throw new Error(`El estado "${nuevo}" no existe.`);
  }
  if (!(TRANSICIONES[desde] ?? []).includes(nuevo)) {
    throw new Error(`Un negocio ${desde.toLowerCase().replace("_", " ")} no puede pasar a ${nuevo.toLowerCase().replace("_", " ")}.`);
  }
}

// Las cafeterias solo se ven en el catalogo si su negocio esta aprobado.
export const cafeteriasVisibles = estado => (estado ?? ESTADOS_NEGOCIO.APROBADO) === ESTADOS_NEGOCIO.APROBADO;
