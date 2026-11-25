// Registro multiempresa: escuelas, negocios, cafeterias y vendedores.
//
// Flujo desde la app (la cafeteria es un negocio independiente; la escuela solo
// le da permiso de vender, fuera de la app, y el trato comercial es con el dueno):
//   1. registrarMiCafeteria -> el dueno crea su negocio (EN_REVISION), su primera
//                              cafeteria (oculta) y su cuenta JEFE
//   2. aprobarNegocio       -> ADMIN_PLATAFORMA lo aprueba; sus cafeterias se ven
//      rechazarNegocio      -> o lo rechaza con un motivo que ve el dueno
//   3. registrarCafeteria   -> el JEFE abre mas cafeterias, en cualquier escuela
//   4. registrarVendedor    -> el JEFE da de alta a quien atiende cada cafeteria
//
// Flujo anterior con codigo de invitacion (se conserva para el seed y la demo):
//   registrarEscuela -> registrarNegocio (con codigo) -> unirNegocioAEscuela
//   5. registro           -> los compradores eligen su escuela del catalogo o escriben
//                            una nueva, que queda en el catalogo (index.js)

import mongoose from "mongoose";
import {
  EscuelaModel,
  NegocioModel,
  CafeteriaModel,
  UsuarioModel
} from "../infrastructure/mongoose-models.js";
import { iniciarSesion, requerirSesion } from "../infrastructure/auth.js";
import { autorizar } from "../infrastructure/autorizacion.js";
import {
  sincronizarEscuela,
  sincronizarNegocio,
  sincronizarCafeteria,
  sincronizarUsuario,
  sincronizarSinFallar
} from "../infrastructure/grafo.js";
import { ROLES } from "../domain/roles.js";
import {
  NOMBRE_ESCUELA_MIN,
  NOMBRE_ESCUELA_MAX,
  CIUDAD_MAX,
  limpiarTexto,
  claveBaseDeNombre,
  claveCandidata
} from "../domain/escuelas.js";
import {
  ESTADOS_NEGOCIO,
  MOTIVO_RECHAZO_MAX,
  validarCambioEstadoNegocio,
  cafeteriasVisibles
} from "../domain/negocios.js";
import { authService } from "../services/auth.service.js";
import {
  datoInvalido,
  manejarDuplicado,
  normalizarClave,
  validarId,
  mapEscuela,
  mapNegocio,
  mapCafeteria,
  mapUsuario,
  enTransaccion,
  crearCuenta,
  generarCodigoInvitacion
} from "./comun.js";

// Escapa texto del usuario antes de meterlo en una expresion regular.
const escaparRegex = texto => texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function escuelaPorCodigo(codigoInvitacion, session = null) {
  const escuela = await EscuelaModel.findOne({
    codigoInvitacion: normalizarClave(codigoInvitacion)
  }).session(session);
  if (!escuela) {
    throw datoInvalido("El codigo de invitacion no es valido.");
  }
  if (!escuela.activa) {
    throw datoInvalido("La escuela de este codigo esta suspendida.");
  }
  return escuela;
}

// Registro de compradores con la escuela escrita a mano: si ya existe una con
// ese nombre (sin importar mayusculas ni acentos) se usa; si no, se crea con
// clave y codigo de invitacion automaticos y queda en el catalogo para los
// siguientes. Devuelve { escuela, nueva }.
export async function buscarOCrearEscuela(nombreEscuela, ciudadEscuela, session = null) {
  const nombre = limpiarTexto(nombreEscuela);
  if (nombre.length < NOMBRE_ESCUELA_MIN || nombre.length > NOMBRE_ESCUELA_MAX) {
    throw datoInvalido(
      `El nombre de la escuela debe tener de ${NOMBRE_ESCUELA_MIN} a ${NOMBRE_ESCUELA_MAX} caracteres.`
    );
  }

  // strength 1: "la salle" encuentra "La Salle" y "Tecnologico" a "Tecnológico"
  const existente = await EscuelaModel.findOne({ nombre })
    .collation({ locale: "es", strength: 1 })
    .session(session);
  if (existente) {
    if (!existente.activa) {
      throw datoInvalido(`La escuela "${existente.nombre}" esta suspendida.`);
    }
    return { escuela: existente, nueva: false };
  }

  const ciudad = limpiarTexto(ciudadEscuela);
  if (!ciudad) {
    throw datoInvalido("Escribe la ciudad de tu escuela.");
  }
  if (ciudad.length > CIUDAD_MAX) {
    throw datoInvalido(`La ciudad debe tener como maximo ${CIUDAD_MAX} caracteres.`);
  }

  const base = claveBaseDeNombre(nombre);
  let clave = null;
  for (let intento = 1; intento <= 50 && !clave; intento++) {
    const candidata = claveCandidata(base, intento);
    const ocupada = await EscuelaModel.exists({ clave: candidata }).session(session);
    if (!ocupada) clave = candidata;
  }
  if (!clave) {
    throw new Error("No se pudo generar una clave para la escuela. Intenta de nuevo.");
  }

  const [escuela] = await EscuelaModel.create(
    [{ clave, nombre, ciudad, codigoInvitacion: generarCodigoInvitacion(clave) }],
    { session }
  );
  return { escuela, nueva: true };
}

// El JEFE de la sesion (con su negocio) y su permiso sobre ese negocio.
async function jefeDeLaSesion(contexto) {
  const { usuarioId } = requerirSesion(contexto);
  const usuario = await UsuarioModel.findById(usuarioId);
  if (!usuario?.negocioId || usuario.rol !== ROLES.JEFE) {
    throw datoInvalido("Solo el dueno de un negocio puede hacer esto.");
  }
  await autorizar(contexto, "NEGOCIO_ADMINISTRAR", { negocioId: usuario.negocioId });
  return usuario;
}

// Escuela por id (del catalogo) o por nombre escrito (se crea si no existe).
async function escuelaElegida({ escuelaId, nombreEscuela, ciudadEscuela }, session = null) {
  if (escuelaId) {
    validarId(escuelaId, "escuela");
    const escuela = await EscuelaModel.findById(escuelaId).session(session);
    if (!escuela) throw datoInvalido("La escuela indicada no existe.");
    if (!escuela.activa) throw datoInvalido("La escuela indicada esta suspendida.");
    return { escuela, nueva: false };
  }
  if (nombreEscuela?.trim()) {
    return buscarOCrearEscuela(nombreEscuela, ciudadEscuela, session);
  }
  throw datoInvalido("Elige la escuela donde esta la cafeteria.");
}

// Aprueba o rechaza un negocio y muestra u oculta sus cafeterias a los alumnos.
async function cambiarEstadoNegocio(negocioId, nuevoEstado, motivo, contexto) {
  validarId(negocioId, "negocio");
  await autorizar(contexto, "PLATAFORMA_ADMINISTRAR");
  const negocio = await NegocioModel.findById(negocioId);
  if (!negocio) throw datoInvalido("El negocio no existe.");
  try {
    validarCambioEstadoNegocio(negocio.estado, nuevoEstado);
  } catch (error) {
    throw datoInvalido(error.message);
  }

  negocio.estado = nuevoEstado;
  negocio.motivoRechazo = nuevoEstado === ESTADOS_NEGOCIO.RECHAZADO ? motivo : "";
  await enTransaccion(async session => {
    await negocio.save({ session });
    await CafeteriaModel.updateMany(
      { negocioId: negocio._id },
      { $set: { activa: cafeteriasVisibles(nuevoEstado) } },
      { session }
    );
  });
  return mapNegocio(negocio);
}

async function sesionPayload(usuario) {
  const { token, expiraEn } = await iniciarSesion(usuario);
  return { token, expiraEn, usuario: mapUsuario(usuario) };
}

export const resolversMultiempresa = {
  Escuela: {
    // Solo las cafeterias activas: es lo que ve el comprador en el catalogo
    cafeterias: async escuela => {
      const docs = await CafeteriaModel.find({ escuelaId: escuela.id, activa: true }).sort({ nombre: 1 });
      return docs.map(mapCafeteria);
    }
  },

  Negocio: {
    escuelas: async negocio => {
      const docs = await EscuelaModel.find({ _id: { $in: negocio.escuelaIds } }).sort({ nombre: 1 });
      return docs.map(mapEscuela);
    },
    cafeterias: async negocio => {
      const docs = await CafeteriaModel.find({ negocioId: negocio.id }).sort({ nombre: 1 });
      return docs.map(mapCafeteria);
    },
    dueno: async negocio => {
      const doc = await UsuarioModel.findById(negocio.duenoId);
      return doc ? mapUsuario(doc) : null;
    }
  },

  Cafeteria: {
    negocio: async cafeteria => {
      const doc = await NegocioModel.findById(cafeteria.negocioId);
      if (!doc) {
        throw new Error("La cafeteria apunta a un negocio que no existe.");
      }
      return mapNegocio(doc);
    }
  },

  Usuario: {
    escuela: async usuario => {
      if (!usuario.escuelaId) return null;
      const doc = await EscuelaModel.findById(usuario.escuelaId);
      return doc ? mapEscuela(doc) : null;
    }
  },

  Query: {
    // Catalogo publico de escuelas activas, con busqueda por nombre, clave o ciudad
    catalogoEscuelas: async (_, { busqueda }) => {
      const filtro = { activa: true };
      const texto = busqueda?.trim();
      if (texto) {
        const regex = new RegExp(escaparRegex(texto), "i");
        filtro.$or = [{ nombre: regex }, { clave: regex }, { ciudad: regex }];
      }
      const docs = await EscuelaModel.find(filtro).sort({ nombre: 1 });
      return docs.map(mapEscuela);
    },

    codigoInvitacion: async (_, { escuelaId }, contexto) => {
      validarId(escuelaId, "escuela");
      await autorizar(contexto, "ESCUELA_ADMINISTRAR", { escuelaId });
      const escuela = await EscuelaModel.findById(escuelaId);
      if (!escuela) throw datoInvalido("La escuela no existe.");
      return escuela.codigoInvitacion;
    },

    miNegocio: async (_, __, contexto) => {
      const { usuarioId } = requerirSesion(contexto);
      const usuario = await UsuarioModel.findById(usuarioId);
      if (!usuario?.negocioId) return null;
      const negocio = await NegocioModel.findById(usuario.negocioId);
      return negocio ? mapNegocio(negocio) : null;
    },

    misVendedores: async (_, __, contexto) => {
      const usuario = await jefeDeLaSesion(contexto);
      const docs = await UsuarioModel.find({ negocioId: usuario.negocioId, rol: ROLES.VENDEDOR }).sort({ nombre: 1 });
      return docs.map(mapUsuario);
    },

    negociosPorEstado: async (_, { estado }, contexto) => {
      await autorizar(contexto, "PLATAFORMA_ADMINISTRAR");
      // Los negocios de antes no tienen el campo: cuentan como aprobados
      const filtro = estado === ESTADOS_NEGOCIO.APROBADO
        ? { $or: [{ estado }, { estado: { $exists: false } }] }
        : { estado };
      const docs = await NegocioModel.find(filtro).sort({ createdAt: -1 });
      return docs.map(mapNegocio);
    }
  },

  Mutation: {
    // Publico: cualquier escuela de cualquier lugar puede darse de alta.
    // Crea la escuela y su administrador en una sola transaccion.
    registrarEscuela: async (_, { input }, contexto) => {
      const { clave, nombre, ciudad, admin } = input;
      const escuelaId = new mongoose.Types.ObjectId();

      const usuarioAdmin = await enTransaccion(async session => {
        try {
          await EscuelaModel.create(
            [{
              _id: escuelaId,
              clave,
              nombre,
              ciudad,
              codigoInvitacion: generarCodigoInvitacion(clave)
            }],
            { session }
          );
        } catch (error) {
          if (error.name === "ValidationError") {
            throw datoInvalido(Object.values(error.errors)[0].message);
          }
          manejarDuplicado(error, `Ya existe una escuela con la clave "${normalizarClave(clave)}".`);
        }
        return crearCuenta(admin, { rol: ROLES.ADMIN_ESCUELA, escuelaId }, session);
      });

      authService.auditarRegistro(usuarioAdmin, contexto);
      const escuela = await EscuelaModel.findById(escuelaId);
      await sincronizarSinFallar(`la escuela ${escuela.clave}`, async () => {
        await sincronizarEscuela(escuela);
        await sincronizarUsuario(usuarioAdmin);
      });
      return {
        escuela: mapEscuela(escuela),
        codigoInvitacion: escuela.codigoInvitacion,
        sesion: await sesionPayload(usuarioAdmin)
      };
    },

    // Invalida el codigo anterior (por si se filtro) y genera otro
    regenerarCodigoInvitacion: async (_, { escuelaId }, contexto) => {
      validarId(escuelaId, "escuela");
      await autorizar(contexto, "ESCUELA_ADMINISTRAR", { escuelaId });
      const escuela = await EscuelaModel.findById(escuelaId);
      if (!escuela) throw datoInvalido("La escuela no existe.");
      escuela.codigoInvitacion = generarCodigoInvitacion(escuela.clave);
      await escuela.save();
      return escuela.codigoInvitacion;
    },

    // Solo el equipo de la plataforma puede suspender o reactivar una escuela
    cambiarEstadoEscuela: async (_, { escuelaId, activa }, contexto) => {
      validarId(escuelaId, "escuela");
      await autorizar(contexto, "PLATAFORMA_ADMINISTRAR");
      const escuela = await EscuelaModel.findByIdAndUpdate(escuelaId, { activa }, { new: true });
      if (!escuela) throw datoInvalido("La escuela no existe.");
      return mapEscuela(escuela);
    },

    // Publico con codigo: el dueno crea su negocio y su cuenta JEFE
    registrarNegocio: async (_, { input }, contexto) => {
      const { codigoInvitacion, nombreNegocio, dueno } = input;
      if (!nombreNegocio?.trim()) {
        throw datoInvalido("El negocio necesita un nombre.");
      }

      const negocioId = new mongoose.Types.ObjectId();
      const duenoId = new mongoose.Types.ObjectId();

      const usuarioJefe = await enTransaccion(async session => {
        const escuela = await escuelaPorCodigo(codigoInvitacion, session);
        await NegocioModel.create(
          [{ _id: negocioId, nombre: nombreNegocio, duenoId, escuelaIds: [escuela._id] }],
          { session }
        );
        return crearCuenta(
          dueno,
          { _id: duenoId, rol: ROLES.JEFE, escuelaId: escuela._id, negocioId },
          session
        );
      });

      authService.auditarRegistro(usuarioJefe, contexto);
      const negocio = await NegocioModel.findById(negocioId);
      await sincronizarSinFallar(`el negocio ${negocio.nombre}`, async () => {
        await sincronizarNegocio(negocio);
        await sincronizarUsuario(usuarioJefe);
      });
      return { negocio: mapNegocio(negocio), sesion: await sesionPayload(usuarioJefe) };
    },

    // Un negocio que ya existe entra a otra escuela con el codigo de esa escuela
    unirNegocioAEscuela: async (_, { codigoInvitacion }, contexto) => {
      const { usuarioId } = requerirSesion(contexto);
      const usuario = await UsuarioModel.findById(usuarioId);
      if (!usuario?.negocioId) {
        throw datoInvalido("Tu cuenta no tiene un negocio.");
      }
      await autorizar(contexto, "NEGOCIO_ADMINISTRAR", { negocioId: usuario.negocioId });

      const escuela = await escuelaPorCodigo(codigoInvitacion);
      const negocio = await NegocioModel.findByIdAndUpdate(
        usuario.negocioId,
        { $addToSet: { escuelaIds: escuela._id } },
        { new: true }
      );
      await sincronizarSinFallar(`el negocio ${negocio.nombre}`, () => sincronizarNegocio(negocio));
      return mapNegocio(negocio);
    },

    // El JEFE abre otra cafeteria. No pide codigo: la cafeteria es un negocio
    // independiente y el permiso de la escuela se arregla fuera de la app.
    registrarCafeteria: async (_, { escuelaId, nombre, ubicacion, nombreEscuela, ciudadEscuela }, contexto) => {
      const { usuarioId } = requerirSesion(contexto);
      const usuario = await UsuarioModel.findById(usuarioId);
      if (!usuario?.negocioId) {
        throw datoInvalido("Solo el dueno de un negocio puede registrar cafeterias.");
      }
      await autorizar(contexto, "CAFETERIA_REGISTRAR", { negocioId: usuario.negocioId });
      if (!nombre?.trim()) throw datoInvalido("La cafeteria necesita un nombre.");

      let escuelaNueva = null;
      const { doc, negocio } = await enTransaccion(async session => {
        const { escuela, nueva } = await escuelaElegida({ escuelaId, nombreEscuela, ciudadEscuela }, session);
        if (nueva) escuelaNueva = escuela;
        const negocio = await NegocioModel.findByIdAndUpdate(
          usuario.negocioId,
          { $addToSet: { escuelaIds: escuela._id } },
          { new: true, session }
        );
        try {
          const [doc] = await CafeteriaModel.create(
            [{
              nombre: nombre.trim(),
              ubicacion: ubicacion?.trim() ?? "",
              escuelaId: escuela._id,
              negocioId: negocio._id,
              // Mientras el negocio no este aprobado, los alumnos no la ven
              activa: cafeteriasVisibles(negocio.estado)
            }],
            { session }
          );
          return { doc, negocio };
        } catch (error) {
          return manejarDuplicado(error, `"${escuela.nombre}" ya tiene una cafeteria llamada "${nombre.trim()}".`);
        }
      });

      await sincronizarSinFallar(`la cafeteria ${doc.nombre}`, async () => {
        if (escuelaNueva) await sincronizarEscuela(escuelaNueva);
        await sincronizarNegocio(negocio);
        await sincronizarCafeteria(doc);
      });
      return mapCafeteria(doc);
    },

    // El JEFE da de alta a un vendedor en una de sus cafeterias
    registrarVendedor: async (_, { cafeteriaId, cuenta }, contexto) => {
      validarId(cafeteriaId, "cafeteria");
      await autorizar(contexto, "VENDEDOR_REGISTRAR", { cafeteriaId });
      const cafeteria = await CafeteriaModel.findById(cafeteriaId);
      if (!cafeteria) throw datoInvalido("La cafeteria no existe.");

      const doc = await crearCuenta(cuenta, {
        rol: ROLES.VENDEDOR,
        escuelaId: cafeteria.escuelaId,
        negocioId: cafeteria.negocioId,
        cafeteriaId: cafeteria._id
      });
      authService.auditarRegistro(doc, contexto);
      await sincronizarSinFallar(`el vendedor ${doc.correo}`, () => sincronizarUsuario(doc));
      return mapUsuario(doc);
    },

    // Publico: el dueno registra su cafeteria desde la app. Se crean el negocio
    // (EN_REVISION), su primera cafeteria (oculta a los alumnos) y la cuenta
    // JEFE, todo o nada. El equipo de la plataforma lo aprueba al cerrar el trato.
    registrarMiCafeteria: async (_, { input }, contexto) => {
      const { dueno, nombreNegocio, nombreCafeteria, ubicacion } = input;
      if (!nombreNegocio?.trim()) throw datoInvalido("El negocio necesita un nombre.");
      if (!nombreCafeteria?.trim()) throw datoInvalido("La cafeteria necesita un nombre.");

      const negocioId = new mongoose.Types.ObjectId();
      const duenoId = new mongoose.Types.ObjectId();
      let escuelaNueva = null;

      const { usuarioJefe, cafeteria } = await enTransaccion(async session => {
        const { escuela, nueva } = await escuelaElegida(input, session);
        if (nueva) escuelaNueva = escuela;

        await NegocioModel.create(
          [{
            _id: negocioId,
            nombre: nombreNegocio.trim(),
            duenoId,
            escuelaIds: [escuela._id],
            estado: ESTADOS_NEGOCIO.EN_REVISION
          }],
          { session }
        );
        let cafeteria;
        try {
          [cafeteria] = await CafeteriaModel.create(
            [{
              nombre: nombreCafeteria.trim(),
              ubicacion: ubicacion?.trim() ?? "",
              escuelaId: escuela._id,
              negocioId,
              activa: false
            }],
            { session }
          );
        } catch (error) {
          manejarDuplicado(error, `"${escuela.nombre}" ya tiene una cafeteria llamada "${nombreCafeteria.trim()}".`);
        }
        // El JEFE pertenece a la escuela de su primera cafeteria
        const usuarioJefe = await crearCuenta(
          dueno,
          { _id: duenoId, rol: ROLES.JEFE, escuelaId: escuela._id, negocioId },
          session
        );
        return { usuarioJefe, cafeteria };
      });

      authService.auditarRegistro(usuarioJefe, contexto);
      const negocio = await NegocioModel.findById(negocioId);
      await sincronizarSinFallar(`el negocio ${negocio.nombre}`, async () => {
        if (escuelaNueva) await sincronizarEscuela(escuelaNueva);
        await sincronizarNegocio(negocio);
        await sincronizarCafeteria(cafeteria);
        await sincronizarUsuario(usuarioJefe);
      });
      return { negocio: mapNegocio(negocio), sesion: await sesionPayload(usuarioJefe) };
    },

    aprobarNegocio: (_, { negocioId }, contexto) =>
      cambiarEstadoNegocio(negocioId, ESTADOS_NEGOCIO.APROBADO, "", contexto),

    rechazarNegocio: (_, { negocioId, motivo }, contexto) => {
      const limpio = String(motivo ?? "").trim();
      if (!limpio) throw datoInvalido("Escribe el motivo del rechazo para que el dueno lo vea.");
      if (limpio.length > MOTIVO_RECHAZO_MAX) {
        throw datoInvalido(`El motivo debe tener como maximo ${MOTIVO_RECHAZO_MAX} caracteres.`);
      }
      return cambiarEstadoNegocio(negocioId, ESTADOS_NEGOCIO.RECHAZADO, limpio, contexto);
    }
  }
};
