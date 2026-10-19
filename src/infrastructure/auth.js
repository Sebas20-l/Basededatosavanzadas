// Autenticacion hibrida: JWT firmado + sesion activa en Redis.
//
// - login:  firma un JWT con un jti (UUID) y guarda  SET sesion:<jti> <userId> EX <segundos>
// - logout: DEL sesion:<jti>  -> el token queda revocado aunque su firma siga siendo valida
// - contexto: cada peticion con token valida la firma Y que la sesion exista en Redis

import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { GraphQLError } from "graphql";
import { redisClient } from "./redis.js";

const JWT_SECRET = process.env.JWT_SECRET || "secreto-solo-para-desarrollo";
export const SESION_TTL_SEGUNDOS = parseInt(process.env.SESION_TTL_SEGUNDOS) || 3600;

if (!process.env.JWT_SECRET) {
  console.warn("AVISO: JWT_SECRET no esta definido en .env; se usa un secreto de desarrollo.");
}

const claveSesion = jti => `sesion:${jti}`;

export function noAutorizado(mensaje = "No autorizado.") {
  return new GraphQLError(mensaje, {
    extensions: { code: "UNAUTHENTICATED", http: { status: 401 } }
  });
}

export async function iniciarSesion(usuarioId) {
  const jti = randomUUID();
  const token = jwt.sign({ sub: String(usuarioId) }, JWT_SECRET, {
    jwtid: jti,
    expiresIn: SESION_TTL_SEGUNDOS
  });

  await redisClient.set(claveSesion(jti), String(usuarioId), { EX: SESION_TTL_SEGUNDOS });
  console.log(`[SESION] SET ${claveSesion(jti)} ${usuarioId} EX ${SESION_TTL_SEGUNDOS}`);

  return { token, expiraEn: SESION_TTL_SEGUNDOS };
}

export async function cerrarSesion(jti) {
  const borradas = await redisClient.del(claveSesion(jti));
  console.log(`[SESION] DEL ${claveSesion(jti)} (${borradas} eliminada)`);
  return borradas === 1;
}

// Se ejecuta en cada peticion GraphQL (funcion context de Apollo).
// Sin encabezado Authorization la peticion sigue como anonima (login, catalogos...).
// Con encabezado, el token DEBE ser valido y su sesion DEBE seguir en Redis;
// si no, se rechaza toda la peticion con 401.
export async function construirContexto({ req }) {
  const encabezado = req.headers.authorization || "";
  if (!encabezado) {
    return { auth: null };
  }

  const [esquema, token] = encabezado.split(" ");
  if (esquema !== "Bearer" || !token) {
    throw noAutorizado("El encabezado debe tener la forma: Authorization: Bearer <token>.");
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (error) {
    throw noAutorizado(`Token invalido: ${error.message}.`);
  }

  if (!payload.jti) {
    throw noAutorizado("El token no tiene identificador de sesion (jti).");
  }

  const usuarioEnSesion = await redisClient.get(claveSesion(payload.jti));
  if (usuarioEnSesion === null || usuarioEnSesion !== payload.sub) {
    throw noAutorizado("La sesion fue cerrada o expiro. Inicia sesion de nuevo.");
  }

  return { auth: { usuarioId: payload.sub, jti: payload.jti } };
}

// Para resolvers que exigen sesion iniciada.
export function requerirSesion(contexto) {
  if (!contexto.auth) {
    throw noAutorizado("Debes iniciar sesion (Authorization: Bearer <token>).");
  }
  return contexto.auth;
}
