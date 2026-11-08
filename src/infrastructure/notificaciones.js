// Avisos al comprador cuando cambia el estado de su pedido.
//
//   notificaciones:<usuarioId>   Lista en Redis con los ultimos 50 avisos (7 dias).
//                                La app los lee con la query misNotificaciones.
//   PUBLISH pedidos:usuario:<id> Canal Pub/Sub para quien quiera escuchar en
//                                tiempo real (ej. un servicio de push o websockets).

import { redisClient } from "./redis.js";

const MAXIMO = 50;
const TTL_SEGUNDOS = 7 * 24 * 60 * 60;

const claveLista = usuarioId => `notificaciones:${usuarioId}`;
export const canalUsuario = usuarioId => `pedidos:usuario:${usuarioId}`;

export async function notificar(usuarioId, { pedidoId, estado, mensaje }) {
  const aviso = JSON.stringify({
    pedidoId: String(pedidoId),
    estado,
    mensaje,
    fecha: new Date().toISOString()
  });
  await redisClient
    .multi()
    .lPush(claveLista(usuarioId), aviso)
    .lTrim(claveLista(usuarioId), 0, MAXIMO - 1)
    .expire(claveLista(usuarioId), TTL_SEGUNDOS)
    .publish(canalUsuario(usuarioId), aviso)
    .exec();
  console.log(`[AVISO] ${canalUsuario(usuarioId)}: ${mensaje}`);
}

export async function leerNotificaciones(usuarioId, limite = 20) {
  const avisos = await redisClient.lRange(claveLista(usuarioId), 0, Math.max(0, limite - 1));
  return avisos.map(texto => JSON.parse(texto));
}
