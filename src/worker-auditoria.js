// Worker consumidor de la auditoria de seguridad (proceso independiente).
//
//   npm run worker
//
// - prefetch(50): RabbitMQ no le entrega mas de 50 mensajes sin confirmar a
//   la vez (contrapresion: protege la memoria del worker).
// - ack manual: el mensaje solo sale de la cola cuando ya se proceso. Si el
//   worker se cae a la mitad, RabbitMQ lo vuelve a entregar.
// - Un mensaje que no es JSON valido (o no es un evento) nunca se va a poder procesar: se descarta
//   (nack sin reencolar) para no ciclarlo para siempre ("poison message").
//   Cualquier otro error se reencola para intentarlo de nuevo.

import "dotenv/config";
import amqp from "amqplib";

// AggregateError (ECONNREFUSED en IPv4 e IPv6) llega sin message
const describir = error => error?.message || error?.code || error?.errors?.[0]?.code || String(error);

const QUEUE_NAME = "eventos-seguridad";
const PREFETCH = 50;

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
      // Persistencia simulada en consola (aqui iria la BD de auditoria)
      console.log(
        `[AUDIT EVENT] [${evento.tipo_evento}] - Usuario: ${evento.email || evento.usuario_id}` +
        ` | Resultado: ${evento.exito} | Motivo: ${evento.motivo} | IP: ${evento.ip_origen ?? "-"}` +
        ` | Fecha: ${evento.timestamp}`
      );
      // Confirmar a RabbitMQ que el evento fue procesado
      channel.ack(msg);
    } catch (err) {
      console.error("Error al procesar mensaje:", err.message);
      // Fallo temporal: se reencola para reintentar
      channel.nack(msg, false, true);
    }
  }, { noAck: false });
}

function reintentar(error) {
  console.error("⚠️ [Worker] RabbitMQ no disponible:", describir(error), "- reintento en 10 s");
  setTimeout(() => startWorker().catch(reintentar), 10000);
}

startWorker().catch(reintentar);
