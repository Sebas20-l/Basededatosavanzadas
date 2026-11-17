// Auditoria de seguridad en ScyllaDB (la escribe el worker, no la API).
//
// Diseno Query-First: la consulta que se necesita es "¿que eventos de tipo X
// hubo el dia D, del mas reciente al mas viejo?". Por eso:
//   - Clave de particion compuesta ((fecha_dia, tipo_evento)): cada dia y tipo
//     vive en su propia particion; ninguna crece sin limite y la carga se
//     reparte entre nodos.
//   - Claves de agrupamiento (timestamp, evento_id): ordenan fisicamente las
//     filas dentro de la particion. evento_id (timeuuid) desempata eventos del
//     mismo milisegundo para que ninguno pise a otro.
//   - CLUSTERING ORDER BY (timestamp DESC): leer "lo mas reciente" no ordena
//     nada en memoria; ya esta guardado asi en disco.
//
// Todas las sentencias van con { prepare: true }: ScyllaDB compila la consulta
// una vez y despues solo recibe los valores en binario. Los valores nunca se
// pegan al texto CQL, asi que no hay inyeccion posible.

import scylla from "@scylladb/driver";
import { scyllaClient, REPLICACION } from "./scylla.js";

const { types } = scylla;

export const KEYSPACE_AUDITORIA = "auditoria";

const ESQUEMA = [
  `CREATE KEYSPACE IF NOT EXISTS ${KEYSPACE_AUDITORIA}
   WITH replication = ${REPLICACION}`,

  `CREATE TABLE IF NOT EXISTS ${KEYSPACE_AUDITORIA}.logs_eventos (
     fecha_dia date,
     tipo_evento text,
     timestamp timestamp,
     evento_id timeuuid,
     usuario_id text,
     email text,
     ip_origen text,
     exito boolean,
     motivo text,
     metadata map<text, text>,
     PRIMARY KEY ((fecha_dia, tipo_evento), timestamp, evento_id)
   ) WITH CLUSTERING ORDER BY (timestamp DESC, evento_id DESC)`
];

const INSERTAR = `
  INSERT INTO ${KEYSPACE_AUDITORIA}.logs_eventos
    (fecha_dia, tipo_evento, timestamp, evento_id, usuario_id, email, ip_origen, exito, motivo, metadata)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// Conecta y crea el keyspace y la tabla si no existen. Lanza si ScyllaDB no responde.
export async function conectarAuditoria() {
  await scyllaClient.connect();
  for (const sentencia of ESQUEMA) {
    await scyllaClient.execute(sentencia);
  }
}

// metadata llega como objeto JSON; la columna es map<text, text>
// (los valores null no se pueden guardar en un map).
function aMapaDeTexto(metadata) {
  const mapa = {};
  for (const [clave, valor] of Object.entries(metadata ?? {})) {
    if (valor == null) continue;
    mapa[clave] = typeof valor === "string" ? valor : JSON.stringify(valor);
  }
  return mapa;
}

// Guarda un evento. Lanza si ScyllaDB no confirma la escritura: el worker
// decide entonces si reintentar (nack) o no.
export async function guardarEventoAuditoria(evento) {
  const fecha = new Date(evento.timestamp ?? Date.now());
  if (Number.isNaN(fecha.getTime())) {
    throw new TypeError(`timestamp invalido: ${evento.timestamp}`);
  }
  const dia = evento.fecha_dia ?? fecha.toISOString().split("T")[0];

  await scyllaClient.execute(
    INSERTAR,
    [
      types.LocalDate.fromString(dia),
      String(evento.tipo_evento),
      fecha,
      types.TimeUuid.fromDate(fecha),
      evento.usuario_id != null ? String(evento.usuario_id) : null,
      evento.email ?? null,
      evento.ip_origen ?? null,
      typeof evento.exito === "boolean" ? evento.exito : null,
      evento.motivo ?? null,
      aMapaDeTexto(evento.metadata)
    ],
    // LOCAL_QUORUM: responde cuando la mayoria de las replicas ya escribio el
    // dato en su commit log (en disco). Con 1 replica (local) es esa replica.
    { prepare: true, consistency: types.consistencies.localQuorum }
  );
}
