// Piezas que comparten varios archivos de resolvers: mappers, validaciones,
// transacciones y creacion de cuentas.

import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { GraphQLError } from "graphql";
import { UsuarioModel } from "../infrastructure/mongoose-models.js";
import { validarLigasDeRol } from "../domain/roles.js";

// -------------------------------------------------
// Errores
// -------------------------------------------------

// Error de validacion que la app puede mostrar tal cual.
export function datoInvalido(mensaje) {
  return new GraphQLError(mensaje, { extensions: { code: "BAD_USER_INPUT" } });
}

// Convierte el error crudo de "llave duplicada" de Mongo en un mensaje claro.
export function manejarDuplicado(error, mensaje) {
  if (error?.code === 11000) {
    throw new Error(mensaje);
  }
  throw error;
}

export const normalizarClave = valor => String(valor).trim().toUpperCase();

export function validarId(id, descripcion) {
  if (!mongoose.isValidObjectId(id)) {
    throw datoInvalido(`El identificador de ${descripcion} no es valido.`);
  }
}

// -------------------------------------------------
// Mappers: documento de Mongo -> forma que expone GraphQL
// -------------------------------------------------
export function mapEscuela(doc) {
  return {
    id: doc._id,
    clave: doc.clave,
    nombre: doc.nombre,
    ciudad: doc.ciudad ?? "",
    activa: doc.activa
  };
}

export function mapNegocio(doc) {
  return {
    id: doc._id,
    nombre: doc.nombre,
    duenoId: doc.duenoId,
    escuelaIds: doc.escuelaIds ?? [],
    activo: doc.activo
  };
}

export function mapCafeteria(doc) {
  return {
    id: doc._id,
    nombre: doc.nombre,
    ubicacion: doc.ubicacion ?? "",
    escuelaId: doc.escuelaId,
    negocioId: doc.negocioId,
    activa: doc.activa
  };
}

export function mapUsuario(doc) {
  return {
    id: doc._id,
    nombre: doc.nombre,
    correo: doc.correo,
    rol: doc.rol,
    escuelaId: doc.escuelaId ?? null,
    negocioId: doc.negocioId ?? null,
    cafeteriaId: doc.cafeteriaId ?? null
  };
}

// -------------------------------------------------
// Transacciones
// -------------------------------------------------

// Ejecuta fn(session) dentro de una transaccion de MongoDB: o se guarda todo
// o no se guarda nada. Requiere replica set (Atlas lo es).
export async function enTransaccion(fn) {
  const session = await mongoose.startSession();
  try {
    let resultado;
    await session.withTransaction(async () => {
      resultado = await fn(session);
    });
    return resultado;
  } catch (error) {
    if (/replica set|Transaction numbers/i.test(error.message)) {
      throw new Error(
        "Este MongoDB no soporta transacciones (requiere replica set, como MongoDB Atlas)."
      );
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

// -------------------------------------------------
// Cuentas de usuario
// -------------------------------------------------
const FORMATO_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN = 6;

// Valida los datos de la cuenta y las ligas de su rol, y la guarda.
//   cuenta: { nombre, correo, password }
//   ligas:  { rol, escuelaId, negocioId, cafeteriaId, _id }
export async function crearCuenta({ nombre, correo, password }, ligas, session = null) {
  const nombreLimpio = String(nombre ?? "").trim();
  const correoLimpio = String(correo ?? "").trim().toLowerCase();

  if (!nombreLimpio) {
    throw datoInvalido("El nombre es obligatorio.");
  }
  if (correoLimpio.length > 254 || !FORMATO_CORREO.test(correoLimpio)) {
    throw datoInvalido("El correo no tiene un formato valido.");
  }
  if (String(password ?? "").length < PASSWORD_MIN) {
    throw datoInvalido(`La contrasena debe tener al menos ${PASSWORD_MIN} caracteres.`);
  }
  try {
    validarLigasDeRol(ligas);
  } catch (error) {
    throw datoInvalido(error.message);
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const [doc] = await UsuarioModel.create(
      [{ ...ligas, nombre: nombreLimpio, correo: correoLimpio, passwordHash }],
      { session }
    );
    return doc;
  } catch (error) {
    if (error?.code === 11000) {
      throw new GraphQLError(`Ya existe un usuario con el correo "${correoLimpio}".`, {
        extensions: { code: "CORREO_DUPLICADO" }
      });
    }
    throw error;
  }
}

// Codigo que el admin de la escuela comparte con los duenos de las cafeterias.
// Ej. "ULSA-4F9A2C"
export function generarCodigoInvitacion(claveEscuela) {
  return `${normalizarClave(claveEscuela)}-${randomBytes(3).toString("hex").toUpperCase()}`;
}
