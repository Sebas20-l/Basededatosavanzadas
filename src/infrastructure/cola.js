// Cola de cocina de cada cafeteria en Redis.
//
//   cola:<cafeteriaId>       Sorted Set: pedidoId con score = hora en que entro (ms).
//                            ZRANK da la posicion del pedido en la fila.
//   cola:<cafeteriaId>:min   Hash: pedidoId -> minutos de preparacion del pedido.
//                            La suma dice cuanto trabajo tiene la cocina por delante.
//
// Un pedido entra al crearse y sale cuando esta LISTO, ENTREGADO o CANCELADO.

import { redisClient } from "./redis.js";

export const CAPACIDAD_PARALELA = parseInt(process.env.CAPACIDAD_PARALELA) || 2;

const claveCola = cafeteriaId => `cola:${cafeteriaId}`;
const claveMinutos = cafeteriaId => `cola:${cafeteriaId}:min`;

export async function agregarACola(cafeteriaId, pedidoId, minutos) {
  await redisClient
    .multi()
    .zAdd(claveCola(cafeteriaId), { score: Date.now(), value: String(pedidoId) })
    .hSet(claveMinutos(cafeteriaId), String(pedidoId), String(minutos))
    .exec();
}

export async function quitarDeCola(cafeteriaId, pedidoId) {
  await redisClient
    .multi()
    .zRem(claveCola(cafeteriaId), String(pedidoId))
    .hDel(claveMinutos(cafeteriaId), String(pedidoId))
    .exec();
}

// Cuantos pedidos hay y cuantos minutos de trabajo suman
export async function estadoCola(cafeteriaId) {
  const minutos = await redisClient.hVals(claveMinutos(cafeteriaId));
  return {
    pedidos: minutos.length,
    minutos: minutos.reduce((suma, valor) => suma + (parseInt(valor) || 0), 0)
  };
}

// 1 = el siguiente en salir; null si el pedido ya no esta en la cola
export async function posicionEnCola(cafeteriaId, pedidoId) {
  const rango = await redisClient.zRank(claveCola(cafeteriaId), String(pedidoId));
  return rango === null ? null : rango + 1;
}
