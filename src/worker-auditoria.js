// Worker consumidor de la auditoria de seguridad (proceso independiente).
//
//   npm run worker
//
// - prefetch(50): RabbitMQ no le entrega mas de 50 mensajes sin confirmar a
//   la vez (contrapresion: protege la memoria del worker).
// - Ingesta en ScyllaDB (auditoria.logs_eventos) con sentencias preparadas;
//   ver src/infrastructure/auditoria.js.
// - ack manual: el mensaje solo sale de la cola cuando ScyllaDB ya confirmo la
//   escritura. Si el worker o ScyllaDB se caen a la mitad, RabbitMQ lo vuelve
//   a entregar y no se pierde ningun evento.
// - Un mensaje que no es JSON valido (o no es un evento) nunca se va a poder procesar: se descarta
//   (nack sin reencolar) para no ciclarlo para siempre ("poison message").
//   Si falla ScyllaDB, el mensaje se reencola (nack con requeue) tras una pausa.
//
// Corre en Docker (servicio "worker" de docker-compose.yml) porque el driver
// de ScyllaDB solo funciona en Linux.

import "dotenv/config";
import amqp from "amqplib";
import { conectarAuditoria, guardarEventoAuditoria, KEYSPACE_AUDITORIA } from "./infrastructure/auditoria.js";

// AggregateError (ECONNREFUSED en IPv4 e IPv6) llega sin message
const describir = error => error?.message || error?.code || error?.errors?.[0]?.code || String(error);

const QUEUE_NAME = "eventos-seguridad";
const PREFETCH = 50;
// Pausa antes de devolver un mensaje a la cola cuando ScyllaDB falla, para no
// ciclarlo miles de veces por segundo mientras la base se recupera.
const PAUSA_REENCOLAR_MS = 2000;

const esperar = ms => new Promise(resolve => setTimeout(resolve, ms));

// No se consume nada hasta que ScyllaDB responda: sin donde guardar, los
// mensajes se quedan seguros en la cola durable.
async function esperarScylla() {
  for (;;) {
    try {
      await conectarAuditoria();
      console.log(`🗄️  ScyllaDB listo; tabla ${KEYSPACE_AUDITORIA}.logs_eventos`);
      return;
    } catch (error) {
      console.error("⚠️ [Worker] ScyllaDB no disponible:", describir(error), "- reintento en 10 s");
      await esperar(10000);
    }
  }
}

async function startWorker() {
  const url = process.env.RABBITMQ_URL || "amqp://guest:guest@localhost:5672";
  const conn = await amqp.connect(url);
  conn.on("error", error => console.error("⚠️ [Worker] Error en la conexion:", error.message));
  conn.on("close", () => {
    console.error("⚠️ [Worker] Conexion con RabbitMQ cerrada. Reintentando en 10 s...");
    setTimeout(() => startWorker().catch(reintentar), 10000);
  });

  const channel = await conn.createChannel();
  await channel.assertQueue(QUEUE_NAME, { durable: true });

  // Limita a 50 mensajes en transito simultaneos para proteger la memoria RAM
  await channel.prefetch(PREFETCH);

  console.log(`📥 Worker escuchando eventos en la cola [${QUEUE_NAME}] (prefetch ${PREFETCH})...`);

  await channel.consume(QUEUE_NAME, async msg => {
    if (msg === null) return; // la cola fue eliminada

    let evento;
    try {
      evento = JSON.parse(msg.content.toString());
      if (!evento?.tipo_evento) throw new Error("no trae tipo_evento");
    } catch (err) {
      console.error("Mensaje invalido, se descarta:", err.message);
      channel.nack(msg, false, false);
      return;
    }

    try {
      await guardarEventoAuditoria(evento);
      console.log(
        `[AUDIT EVENT] [${evento.tipo_evento}] - Usuario: ${evento.email || evento.usuario_id}` +
        ` | Resultado: ${evento.exito} | Motivo: ${evento.motivo} | IP: ${evento.ip_origen ?? "-"}` +
        ` | Fecha: ${evento.timestamp} -> ScyllaDB OK`
      );
      // ScyllaDB ya confirmo: ahora si se retira de RabbitMQ
      channel.ack(msg);
    } catch (err) {
      if (err instanceof TypeError) {
        // Datos que nunca van a poder guardarse (ej. timestamp invalido)
        console.error("Mensaje invalido, se descarta:", err.message);
        channel.nack(msg, false, false);
        return;
      }
      console.error("Error al guardar en ScyllaDB, se reencola:", describir(err));
      await esperar(PAUSA_REENCOLAR_MS);
      // Fallo temporal: se reencola para reintentar
      channel.nack(msg, false, true);
    }
  }, { noAck: false });
}

function reintentar(error) {
  console.error("⚠️ [Worker] RabbitMQ no disponible:", describir(error), "- reintento en 10 s");
  setTimeout(() => startWorker().catch(reintentar), 10000);
}

await esperarScylla();
startWorker().catch(reintentar);
