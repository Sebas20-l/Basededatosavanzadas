// ScyllaDB: bitacora de eventos de pedidos y metricas por hora.
//
// Por que ScyllaDB y no MongoDB para esto: son escrituras que solo se agregan
// (nunca se editan), llegan muchas a la vez y siempre se consultan por la misma
// llave (un pedido, o una cafeteria en un dia). ScyllaDB esta hecha para eso:
// cada tabla se disena para UNA consulta y se particiona por esa llave.
//
// Variables en .env (todas opcionales; sin ellas usa el contenedor de docker-compose):
//   SCYLLA_CONTACT_POINTS   nodos separados por coma (por defecto localhost:9042)
//   SCYLLA_DATACENTER       nombre del datacenter (por defecto datacenter1)
//   SCYLLA_USER             usuario (ScyllaDB Cloud; el contenedor local no pide)
//   SCYLLA_PASSWORD         contrasena (ScyllaDB Cloud)
//   SCYLLA_REPLICAS         copias de cada dato (por defecto 1; en la nube 3)
//   SCYLLA_SSL              "true" para cifrar la conexion (si el cluster lo pide)
//   ZONA_HORARIA            (por defecto America/Chihuahua; define el "dia" y la "hora")
//
// Si ScyllaDB no esta disponible la API sigue funcionando: los eventos se
// omiten (con aviso en consola) y los reportes de ScyllaDB responden con error.
//
// Se usa el driver oficial de ScyllaDB (@scylladb/driver). Solo funciona en
// Linux, por eso la API corre en un contenedor de Docker (ver docker-compose.yml).

import scylla from "@scylladb/driver";
import { GraphQLError } from "graphql";

const KEYSPACE = "pide_y_recoge";
const ZONA_HORARIA = process.env.ZONA_HORARIA || "America/Chihuahua";

const DATACENTER = process.env.SCYLLA_DATACENTER || "datacenter1";
const REPLICAS = parseInt(process.env.SCYLLA_REPLICAS) || 1;

// Replicacion de los keyspaces (tambien la usa auditoria.js)
export const REPLICACION = `{'class': 'NetworkTopologyStrategy', '${DATACENTER}': ${REPLICAS}}`;

const { types } = scylla;

export const scyllaClient = new scylla.Client({
  contactPoints: (process.env.SCYLLA_CONTACT_POINTS || "localhost:9042").split(",").map(p => p.trim()),
  localDataCenter: DATACENTER,
  // ScyllaDB Cloud pide usuario y contrasena; el contenedor local no
  credentials: process.env.SCYLLA_USER
    ? { username: process.env.SCYLLA_USER, password: process.env.SCYLLA_PASSWORD || "" }
    : undefined,
  sslOptions: process.env.SCYLLA_SSL === "true" ? {} : undefined
});

let disponible = false;

const ESQUEMA = [
  // NetworkTopologyStrategy funciona igual en local y en la nube. Los tablets se
  // apagan porque ScyllaDB no permite tablas counter (ventas_por_hora) con tablets.
  `CREATE KEYSPACE IF NOT EXISTS ${KEYSPACE}
   WITH replication = ${REPLICACION}
   AND tablets = {'enabled': false}`,

  // Consulta: "historial de un pedido". Particion = un pedido, ordenado por fecha.
  `CREATE TABLE IF NOT EXISTS ${KEYSPACE}.eventos_por_pedido (
     pedido_id text,
     fecha timestamp,
     estado text,
     usuario_id text,
     cafeteria_id text,
     PRIMARY KEY ((pedido_id), fecha)
   ) WITH CLUSTERING ORDER BY (fecha ASC)`,

  // Consulta: "actividad de una cafeteria en un dia". Particion = cafeteria + dia,
  // asi ninguna particion crece sin limite. Lo mas reciente primero.
  `CREATE TABLE IF NOT EXISTS ${KEYSPACE}.eventos_por_cafeteria_dia (
     cafeteria_id text,
     dia date,
     fecha timestamp,
     pedido_id text,
     estado text,
     usuario_id text,
     total decimal,
     PRIMARY KEY ((cafeteria_id, dia), fecha, pedido_id)
   ) WITH CLUSTERING ORDER BY (fecha DESC, pedido_id ASC)`,

  // Consulta: "horas pico de una cafeteria en un dia". Contadores (counter):
  // ScyllaDB los incrementa sin leer antes, ideal para metricas.
  `CREATE TABLE IF NOT EXISTS ${KEYSPACE}.ventas_por_hora (
     cafeteria_id text,
     dia date,
     hora int,
     pedidos counter,
     piezas counter,
     entregados counter,
     ingresos_centavos counter,
     PRIMARY KEY ((cafeteria_id, dia), hora)
   ) WITH CLUSTERING ORDER BY (hora ASC)`
];

export async function conectarScylla() {
  try {
    await scyllaClient.connect();
    for (const sentencia of ESQUEMA) {
      await scyllaClient.execute(sentencia);
    }
    disponible = true;
    console.log("ScyllaDB conectado correctamente; keyspace:", KEYSPACE);
  } catch (error) {
    disponible = false;
    console.warn(
      `AVISO: ScyllaDB no esta disponible (${error.message}). ` +
      "La API sigue funcionando, pero no se guardaran eventos ni metricas por hora."
    );
  }
}

// "2026-11-08" y 14 (hora local) de una fecha, en la zona horaria de la escuela
export function diaYHora(fecha = new Date()) {
  const dia = fecha.toLocaleDateString("en-CA", { timeZone: ZONA_HORARIA });
  const hora = parseInt(fecha.toLocaleString("en-US", { hour: "2-digit", hour12: false, timeZone: ZONA_HORARIA })) % 24;
  return { dia, hora };
}

// Los contadores llegan como BigInt
const aNumero = valor => Number(valor ?? 0);

// Guarda un cambio de estado de un pedido. No lanza errores: si ScyllaDB
// falla, el pedido ya quedo guardado en MongoDB y solo se pierde la metrica.
//   metricas: { pedidos, piezas, entregados, ingresosCentavos } a sumar en la hora
export async function registrarEvento({ pedido, estado, usuarioId, fecha = new Date(), metricas = null }) {
  if (!disponible) return;
  const { dia, hora } = diaYHora(fecha);
  const pedidoId = String(pedido._id);
  const cafeteriaId = String(pedido.cafeteriaId);
  const usuario = usuarioId ? String(usuarioId) : null;

  try {
    await scyllaClient.batch(
      [
        {
          query: `INSERT INTO ${KEYSPACE}.eventos_por_pedido (pedido_id, fecha, estado, usuario_id, cafeteria_id)
                  VALUES (?, ?, ?, ?, ?)`,
          params: [pedidoId, fecha, estado, usuario, cafeteriaId]
        },
        {
          query: `INSERT INTO ${KEYSPACE}.eventos_por_cafeteria_dia
                  (cafeteria_id, dia, fecha, pedido_id, estado, usuario_id, total)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
          params: [
            cafeteriaId,
            types.LocalDate.fromString(dia),
            fecha,
            pedidoId,
            estado,
            usuario,
            types.BigDecimal.fromString(String(pedido.total?.monto ?? 0))
          ]
        }
      ],
      { prepare: true }
    );

    if (metricas) {
      // Los contadores no pueden ir en el mismo batch que filas normales
      await scyllaClient.execute(
        `UPDATE ${KEYSPACE}.ventas_por_hora
         SET pedidos = pedidos + ?, piezas = piezas + ?, entregados = entregados + ?,
             ingresos_centavos = ingresos_centavos + ?
         WHERE cafeteria_id = ? AND dia = ? AND hora = ?`,
        [
          BigInt(metricas.pedidos ?? 0),
          BigInt(metricas.piezas ?? 0),
          BigInt(metricas.entregados ?? 0),
          BigInt(metricas.ingresosCentavos ?? 0),
          cafeteriaId,
          types.LocalDate.fromString(dia),
          hora
        ],
        { prepare: true }
      );
    }
    console.log(`[SCYLLA] evento ${estado} del pedido ${pedidoId} (${dia} ${hora}:00)`);
  } catch (error) {
    console.error(`[SCYLLA] No se pudo guardar el evento ${estado} del pedido ${pedidoId}: ${error.message}`);
  }
}

function requerirScylla() {
  if (!disponible) {
    throw new GraphQLError("Los reportes de eventos no estan disponibles: ScyllaDB no esta conectado.", {
      extensions: { code: "SERVICE_UNAVAILABLE" }
    });
  }
}

function mapEvento(fila) {
  return {
    pedidoId: fila.pedido_id,
    estado: fila.estado,
    fecha: fila.fecha.toISOString(),
    usuarioId: fila.usuario_id ?? null,
    cafeteriaId: fila.cafeteria_id ?? null,
    total: fila.total != null ? Number(fila.total.toString()) : null
  };
}

export async function eventosDePedido(pedidoId) {
  requerirScylla();
  const resultado = await scyllaClient.execute(
    `SELECT * FROM ${KEYSPACE}.eventos_por_pedido WHERE pedido_id = ?`,
    [String(pedidoId)],
    { prepare: true }
  );
  return resultado.rows.map(mapEvento);
}

export async function eventosDeCafeteria(cafeteriaId, dia, limite = 100) {
  requerirScylla();
  const resultado = await scyllaClient.execute(
    `SELECT * FROM ${KEYSPACE}.eventos_por_cafeteria_dia
     WHERE cafeteria_id = ? AND dia = ? LIMIT ?`,
    [String(cafeteriaId), types.LocalDate.fromString(dia), limite],
    { prepare: true }
  );
  return resultado.rows.map(fila => ({ ...mapEvento(fila), cafeteriaId: String(cafeteriaId) }));
}

export async function ventasPorHora(cafeteriaId, dia) {
  requerirScylla();
  const resultado = await scyllaClient.execute(
    `SELECT hora, pedidos, piezas, entregados, ingresos_centavos FROM ${KEYSPACE}.ventas_por_hora
     WHERE cafeteria_id = ? AND dia = ?`,
    [String(cafeteriaId), types.LocalDate.fromString(dia)],
    { prepare: true }
  );
  return resultado.rows.map(fila => ({
    hora: fila.hora,
    pedidos: aNumero(fila.pedidos),
    piezas: aNumero(fila.piezas),
    entregados: aNumero(fila.entregados),
    ingresos: aNumero(fila.ingresos_centavos) / 100
  }));
}
