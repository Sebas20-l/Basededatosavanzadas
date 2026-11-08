// Cassandra: bitacora de eventos de pedidos y metricas por hora.
//
// Por que Cassandra y no MongoDB para esto: son escrituras que solo se agregan
// (nunca se editan), llegan muchas a la vez y siempre se consultan por la misma
// llave (un pedido, o una cafeteria en un dia). Cassandra esta hecha para eso:
// cada tabla se disena para UNA consulta y se particiona por esa llave.
//
// Variables en .env (opcionales):
//   CASSANDRA_CONTACT_POINTS   (por defecto localhost:9042, el contenedor de docker-compose)
//   CASSANDRA_DATACENTER       (por defecto datacenter1)
//   ZONA_HORARIA               (por defecto America/Chihuahua; define el "dia" y la "hora")
//
// Si Cassandra no esta disponible la API sigue funcionando: los eventos se
// omiten (con aviso en consola) y los reportes de Cassandra responden con error.

import cassandra from "cassandra-driver";
import { GraphQLError } from "graphql";

const KEYSPACE = "pide_y_recoge";
const ZONA_HORARIA = process.env.ZONA_HORARIA || "America/Chihuahua";

export const cassandraClient = new cassandra.Client({
  contactPoints: (process.env.CASSANDRA_CONTACT_POINTS || "localhost:9042").split(","),
  localDataCenter: process.env.CASSANDRA_DATACENTER || "datacenter1"
});

let disponible = false;

const ESQUEMA = [
  `CREATE KEYSPACE IF NOT EXISTS ${KEYSPACE}
   WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`,

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
  // Cassandra los incrementa sin leer antes, ideal para metricas.
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

export async function conectarCassandra() {
  try {
    await cassandraClient.connect();
    for (const sentencia of ESQUEMA) {
      await cassandraClient.execute(sentencia);
    }
    disponible = true;
    console.log("Cassandra conectado correctamente; keyspace:", KEYSPACE);
  } catch (error) {
    disponible = false;
    console.warn(
      `AVISO: Cassandra no esta disponible (${error.message}). ` +
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

const aNumero = valor => (valor?.toNumber ? valor.toNumber() : Number(valor ?? 0));

// Guarda un cambio de estado de un pedido. No lanza errores: si Cassandra
// falla, el pedido ya quedo guardado en MongoDB y solo se pierde la metrica.
//   metricas: { pedidos, piezas, entregados, ingresosCentavos } a sumar en la hora
export async function registrarEvento({ pedido, estado, usuarioId, fecha = new Date(), metricas = null }) {
  if (!disponible) return;
  const { dia, hora } = diaYHora(fecha);
  const pedidoId = String(pedido._id);
  const cafeteriaId = String(pedido.cafeteriaId);
  const usuario = usuarioId ? String(usuarioId) : null;

  try {
    await cassandraClient.batch(
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
            cassandra.types.LocalDate.fromString(dia),
            fecha,
            pedidoId,
            estado,
            usuario,
            cassandra.types.BigDecimal.fromString(String(pedido.total?.monto ?? 0))
          ]
        }
      ],
      { prepare: true }
    );

    if (metricas) {
      // Los contadores no pueden ir en el mismo batch que filas normales
      await cassandraClient.execute(
        `UPDATE ${KEYSPACE}.ventas_por_hora
         SET pedidos = pedidos + ?, piezas = piezas + ?, entregados = entregados + ?,
             ingresos_centavos = ingresos_centavos + ?
         WHERE cafeteria_id = ? AND dia = ? AND hora = ?`,
        [
          cassandra.types.Long.fromNumber(metricas.pedidos ?? 0),
          cassandra.types.Long.fromNumber(metricas.piezas ?? 0),
          cassandra.types.Long.fromNumber(metricas.entregados ?? 0),
          cassandra.types.Long.fromNumber(metricas.ingresosCentavos ?? 0),
          cafeteriaId,
          cassandra.types.LocalDate.fromString(dia),
          hora
        ],
        { prepare: true }
      );
    }
    console.log(`[CASSANDRA] evento ${estado} del pedido ${pedidoId} (${dia} ${hora}:00)`);
  } catch (error) {
    console.error(`[CASSANDRA] No se pudo guardar el evento ${estado} del pedido ${pedidoId}: ${error.message}`);
  }
}

function requerirCassandra() {
  if (!disponible) {
    throw new GraphQLError("Los reportes de eventos no estan disponibles: Cassandra no esta conectado.", {
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
  requerirCassandra();
  const resultado = await cassandraClient.execute(
    `SELECT * FROM ${KEYSPACE}.eventos_por_pedido WHERE pedido_id = ?`,
    [String(pedidoId)],
    { prepare: true }
  );
  return resultado.rows.map(mapEvento);
}

export async function eventosDeCafeteria(cafeteriaId, dia, limite = 100) {
  requerirCassandra();
  const resultado = await cassandraClient.execute(
    `SELECT * FROM ${KEYSPACE}.eventos_por_cafeteria_dia
     WHERE cafeteria_id = ? AND dia = ? LIMIT ?`,
    [String(cafeteriaId), cassandra.types.LocalDate.fromString(dia), limite],
    { prepare: true }
  );
  return resultado.rows.map(fila => ({ ...mapEvento(fila), cafeteriaId: String(cafeteriaId) }));
}

export async function ventasPorHora(cafeteriaId, dia) {
  requerirCassandra();
  const resultado = await cassandraClient.execute(
    `SELECT hora, pedidos, piezas, entregados, ingresos_centavos FROM ${KEYSPACE}.ventas_por_hora
     WHERE cafeteria_id = ? AND dia = ?`,
    [String(cafeteriaId), cassandra.types.LocalDate.fromString(dia)],
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
