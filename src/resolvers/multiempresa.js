// Registro multiempresa: escuelas, negocios, cafeterias y vendedores.
//
// Flujo (la escuela se registra primero):
//   1. registrarEscuela   -> crea la escuela, su ADMIN_ESCUELA y un codigo de invitacion
//   2. registrarNegocio   -> el dueno usa ese codigo: crea su negocio y su cuenta JEFE
//   3. registrarCafeteria -> el JEFE da de alta sus cafeterias en esa escuela
//   4. registrarVendedor  -> el JEFE da de alta a quien atiende cada cafeteria
//   5. registro           -> los compradores eligen su escuela del catalogo (index.js)

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
    }
  },

  Mutation: {
    // Publico: cualquier escuela de cualquier lugar puede darse de alta.
    // Crea la escuela y su administrador en una sola transaccion.
    registrarEscuela: async (_, { input }) => {
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
    registrarNegocio: async (_, { input }) => {
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

    // El JEFE abre una cafeteria de su negocio en una escuela donde ya entro
    registrarCafeteria: async (_, { escuelaId, nombre, ubicacion }, contexto) => {
      validarId(escuelaId, "escuela");
      const { usuarioId } = requerirSesion(contexto);
      const usuario = await UsuarioModel.findById(usuarioId);
      if (!usuario?.negocioId) {
        throw datoInvalido("Solo el dueno de un negocio puede registrar cafeterias.");
      }
      await autorizar(contexto, "CAFETERIA_REGISTRAR", { negocioId: usuario.negocioId });

      const [escuela, negocio] = await Promise.all([
        EscuelaModel.findById(escuelaId),
        NegocioModel.findById(usuario.negocioId)
      ]);
      if (!escuela) throw datoInvalido("La escuela indicada no existe.");
      if (!escuela.activa) throw datoInvalido("La escuela indicada esta suspendida.");
      if (!negocio.escuelaIds.some(id => String(id) === String(escuelaId))) {
        throw datoInvalido(
          "Tu negocio no esta en esa escuela. Pide su codigo de invitacion y usa unirNegocioAEscuela."
        );
      }

      try {
        const doc = await new CafeteriaModel({
          nombre,
          ubicacion: ubicacion ?? "",
          escuelaId,
          negocioId: negocio._id
        }).save();
        await sincronizarSinFallar(`la cafeteria ${doc.nombre}`, () => sincronizarCafeteria(doc));
        return mapCafeteria(doc);
      } catch (error) {
        return manejarDuplicado(
          error,
          `La escuela "${escuela.clave}" ya tiene una cafeteria llamada "${nombre}".`
        );
      }
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
      await sincronizarSinFallar(`el vendedor ${doc.correo}`, () => sincronizarUsuario(doc));
      return mapUsuario(doc);
    }
  }
};
