// Patron Cache-Aside sobre Redis.
//
// 1. Se busca la clave en Redis (redisClient.get).
// 2. Si existe (HIT), se responde desde Redis.
// 3. Si no existe (MISS), se lee de MongoDB y se guarda en Redis con TTL (SET ... EX).
// Las escrituras borran las claves afectadas (redisClient.del) para no servir datos viejos.
//
// Cada lectura imprime su latencia en la consola, para comparar MongoDB contra Redis.

import { performance } from "node:perf_hooks";
import { redisClient } from "./redis.js";

export const CACHE_TTL_SEGUNDOS = parseInt(process.env.CACHE_TTL_SEGUNDOS) || 60;

// Nombres de las claves en un solo lugar, para que lectura e invalidacion coincidan.
export const clavesCache = {
  producto: id => `cache:producto:${id}`,
  productosPorCafeteria: cafeteriaId => `cache:productos:cafeteria:${cafeteriaId}`,
  productosPorReponer: cafeteriaId => `cache:productos:reponer:${cafeteriaId}`,
  productosMasVendidos: cafeteriaId => `cache:reporte:masvendidos:${cafeteriaId}`,
  monedas: () => "cache:catalogo:monedas",
  estadosPedido: () => "cache:catalogo:estados"
};

const ms = valor => valor.toFixed(3);

export async function obtenerConCache(clave, cargarDesdeMongo, ttl = CACHE_TTL_SEGUNDOS) {
  const inicioRedis = performance.now();
  const enCache = await redisClient.get(clave);
  const latenciaRedis = performance.now() - inicioRedis;

  if (enCache !== null) {
    console.log(`[CACHE HIT ] ${clave} -> Redis: ${ms(latenciaRedis)} ms`);
    return JSON.parse(enCache);
  }

  const inicioMongo = performance.now();
  const datos = await cargarDesdeMongo();
  const latenciaMongo = performance.now() - inicioMongo;

  await redisClient.set(clave, JSON.stringify(datos), { EX: ttl });
  console.log(
    `[CACHE MISS] ${clave} -> MongoDB: ${ms(latenciaMongo)} ms ` +
    `(guardado en Redis con TTL de ${ttl} s)`
  );
  return datos;
}

export async function invalidarCache(...claves) {
  if (claves.length === 0) return;
  const borradas = await redisClient.del(claves);
  console.log(`[CACHE DEL ] ${claves.join(", ")} (${borradas} clave(s) eliminada(s))`);
}
