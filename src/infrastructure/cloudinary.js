// Servicio de infraestructura para integracion con Cloudinary.
// Utiliza el SDK oficial (cloudinary.v2) para generar firmas de subida seguras.
//
// El API Secret permanece exclusivamente en el servidor y nunca se envia al cliente.
// Las variables de entorno se validan al momento de solicitar una firma (no al arrancar),
// permitiendo que el servidor inicie incluso si Cloudinary aun no esta configurado.

import { v2 as cloudinary } from "cloudinary";
import { GraphQLError } from "graphql";

export const DEFAULT_UPLOAD_PRESET = "cafe_signed_preset";

// Carga diferida del cliente Redis de produccion.
// Solo se importa cuando el llamador NO inyecta un cliente (produccion).
// De este modo, las pruebas unitarias que inyectan un cliente falso no dependen
// de REDIS_URL ni crean una conexion real; ademas, si REDIS_URL fuese invalida,
// el simple hecho de importar este modulo no falla.
let redisClientPorDefecto;

async function obtenerClienteRedisPorDefecto() {
  if (!redisClientPorDefecto) {
    ({ redisClient: redisClientPorDefecto } = await import("./redis.js"));
  }
  return redisClientPorDefecto;
}

// Cuotas de emision de firmas para proteccion contra abusos
export const LIMITE_PERFIL_POR_HORA = 5;
export const LIMITE_PRODUCTO_USUARIO_POR_HORA = 20;
export const LIMITE_PRODUCTO_CAFETERIA_POR_HORA = 60;
export const RATE_LIMIT_TTL_SEGUNDOS = 3600; // 1 hora

/**
 * Script Lua evaluado atomicamente en Redis.
 * Comprueba cuota individual y cuota global (si aplica) en una sola operacion atomica.
 * Si alguna cuota se excede, no incrementa ningun contador.
 *
 * Retorna:
 *   1  -> Cuota disponible (contadores incrementados atomicamente con TTL)
 *  -1  -> Cuota individual excedida
 *  -2  -> Cuota global (cafeteria) excedida
 */
export const LUA_RATE_LIMIT = `
local actual1 = tonumber(redis.call('GET', KEYS[1]) or '0')
if actual1 >= tonumber(ARGV[1]) then
  return -1
end

if #KEYS > 1 and KEYS[2] ~= '' then
  local actual2 = tonumber(redis.call('GET', KEYS[2]) or '0')
  if actual2 >= tonumber(ARGV[3]) then
    return -2
  end
  local nuevo2 = redis.call('INCR', KEYS[2])
  if nuevo2 == 1 then
    redis.call('EXPIRE', KEYS[2], ARGV[2])
  end
end

local nuevo1 = redis.call('INCR', KEYS[1])
if nuevo1 == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end

return 1
`;

/**
 * Verifica atomicamente las cuotas de emision de firmas en Redis.
 * Lanza GraphQLError con codigo TOO_MANY_REQUESTS (429) si se superan los limites.
 *
 * @param {Object} params
 * @param {"PRODUCTO"|"PERFIL"} params.tipo
 * @param {string} params.usuarioId
 * @param {string} [params.cafeteriaId]
 * @param {Object} [params.clienteRedis] Permite inyectar cliente para pruebas unitarias.
 *                                       Si se omite, se carga el cliente Redis de produccion.
 */
export async function verificarLimiteFirma({ tipo, usuarioId, cafeteriaId, clienteRedis }) {
  const cliente = clienteRedis ?? (await obtenerClienteRedisPorDefecto());

  let keys = [];
  let args = [];

  if (tipo === "PERFIL") {
    // Cuota individual para foto de perfil: maximo 5 por hora
    const keyUsuario = `ratelimit:firma:perfil:${usuarioId}`;
    keys = [keyUsuario];
    args = [
      String(LIMITE_PERFIL_POR_HORA),
      String(RATE_LIMIT_TTL_SEGUNDOS)
    ];
  } else if (tipo === "PRODUCTO") {
    // Cuota individual de vendedor en la cafeteria: maximo 20 por hora
    const keyUsuarioCafe = `ratelimit:firma:prod:usr:${usuarioId}:cafe:${cafeteriaId}`;
    // Cuota global combinada de la cafeteria: maximo 60 por hora
    const keyGlobalCafe = `ratelimit:firma:prod:cafe:${cafeteriaId}`;

    keys = [keyUsuarioCafe, keyGlobalCafe];
    args = [
      String(LIMITE_PRODUCTO_USUARIO_POR_HORA),
      String(RATE_LIMIT_TTL_SEGUNDOS),
      String(LIMITE_PRODUCTO_CAFETERIA_POR_HORA)
    ];
  }

  const resultado = await cliente.eval(LUA_RATE_LIMIT, {
    keys,
    arguments: args
  });

  if (resultado === -1) {
    const mensaje = tipo === "PERFIL"
      ? `Has superado el limite de firmas para foto de perfil (${LIMITE_PERFIL_POR_HORA} por hora). Intenta de nuevo mas tarde.`
      : `Has superado tu limite individual de firmas para esta cafeteria (${LIMITE_PRODUCTO_USUARIO_POR_HORA} por hora). Intenta de nuevo mas tarde.`;

    throw new GraphQLError(mensaje, {
      extensions: { code: "TOO_MANY_REQUESTS", http: { status: 429 } }
    });
  }

  if (resultado === -2) {
    throw new GraphQLError(
      `Se ha superado el limite global de firmas para esta cafeteria (${LIMITE_PRODUCTO_CAFETERIA_POR_HORA} por hora). Intenta de nuevo mas tarde.`,
      { extensions: { code: "TOO_MANY_REQUESTS", http: { status: 429 } } }
    );
  }
}

/**
 * Obtiene y valida las credenciales de Cloudinary desde process.env.
 * Lanza un error si alguna de las tres variables obligatorias esta ausente.
 */
function obtenerCredenciales() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    const faltantes = [];
    if (!cloudName) faltantes.push("CLOUDINARY_CLOUD_NAME");
    if (!apiKey) faltantes.push("CLOUDINARY_API_KEY");
    if (!apiSecret) faltantes.push("CLOUDINARY_API_SECRET");

    throw new GraphQLError(
      `Configuracion incompleta de Cloudinary: faltan las variables de entorno [${faltantes.join(", ")}].`,
      { extensions: { code: "INTERNAL_SERVER_ERROR" } }
    );
  }

  return { cloudName, apiKey, apiSecret };
}

/**
 * Valida que las credenciales de Cloudinary esten configuradas.
 * No genera firma ni consume rate limit; se usa antes de tocar Redis.
 */
export function validarCredencialesCloudinary() {
  obtenerCredenciales();
}

/**
 * Genera los parametros firmados para subida directa desde el cliente.
 *
 * @param {Object} params
 * @param {"PRODUCTO"|"PERFIL"} params.tipo
 * @param {string} [params.cafeteriaId]
 * @param {string} params.usuarioId
 * @returns {{ signature: string, timestamp: number, apiKey: string, cloudName: string, folder: string, uploadPreset: string }}
 */
export function generarFirmaSubida({ tipo, cafeteriaId, usuarioId }) {
  const { cloudName, apiKey, apiSecret } = obtenerCredenciales();
  const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET || DEFAULT_UPLOAD_PRESET;

  // Determinacion estricta de carpeta segun tipo y contexto del usuario:
  // - PERFIL: asociado al ID del usuario autenticado (perfiles/<usuarioId>)
  // - PRODUCTO: asociado a la cafeteria autorizada (productos/cafeteria_<cafeteriaId>)
  const folder = tipo === "PERFIL"
    ? `perfiles/${usuarioId}`
    : `productos/cafeteria_${cafeteriaId}`;

  const timestamp = Math.round(Date.now() / 1000);

  // Parametros que seran validados por Cloudinary al recibir la imagen.
  // Cualquier alteracion de folder o upload_preset invalidara la firma en Cloudinary.
  const paramsToSign = {
    folder,
    timestamp,
    upload_preset: uploadPreset
  };

  // Firma generada con el algoritmo oficial de Cloudinary (SHA-1 / SHA-256)
  const signature = cloudinary.utils.api_sign_request(paramsToSign, apiSecret);

  return {
    signature,
    timestamp,
    apiKey,
    cloudName,
    folder,
    uploadPreset
  };
}

/**
 * Prepara una firma de subida en el orden correcto:
 *   1. Valida la configuracion de Cloudinary (no consume cuota si falta algo).
 *   2. Verifica el rate limit atomico en Redis.
 *   3. Genera la firma.
 *
 * @param {Object} params
 * @param {"PRODUCTO"|"PERFIL"} params.tipo
 * @param {string} [params.cafeteriaId]
 * @param {string} params.usuarioId
 * @param {Object} [params.clienteRedis] Permite inyectar cliente para pruebas
 */
export async function prepararFirmaSubida({ tipo, cafeteriaId, usuarioId, clienteRedis }) {
  validarCredencialesCloudinary();
  await verificarLimiteFirma({ tipo, usuarioId, cafeteriaId, clienteRedis });
  return generarFirmaSubida({ tipo, cafeteriaId, usuarioId });
}
