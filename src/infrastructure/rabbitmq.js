// Productor de eventos de seguridad hacia RabbitMQ (Fire-and-Forget).
//
// Principio Fail-Safe: si el broker no esta, el login y el registro siguen
// funcionando; solo se pierde la auditoria mientras tanto (modo degradado).
//
//   RABBITMQ_URL   (opcional; por defecto amqp://guest:guest@localhost:5672)
//
// Diferencias con el codigo base de la actividad:
//  - Se escuchan los eventos 'error' y 'close' de la conexion. Sin esos
//    listeners, si RabbitMQ se cae con el servidor corriendo, amqplib emite un
//    'error' que nadie atiende y Node.js se cae (justo lo que la prueba 4 pide
//    que NO pase).
//  - Reconexion automatica cada RABBITMQ_REINTENTO_MS (10 s) cuando se cae.
//  - Si el buffer del canal esta lleno, sendToQueue devuelve false: se avisa
//    (contrapresion del lado del productor).

import amqp from "amqplib";

export const QUEUE_NAME = "eventos-seguridad";
const REINTENTO_MS = parseInt(process.env.RABBITMQ_REINTENTO_MS) || 10000;

let channel = null;
let reintento = null;

// AggregateError (ECONNREFUSED en IPv4 e IPv6) llega sin message
const describir = error => error?.message || error?.code || error?.errors?.[0]?.code || String(error);

const ocultarCredenciales = url => url.replace(/\/\/[^@/]*@/, "//***@");

function programarReintento() {
  if (reintento) return;
  reintento = setTimeout(() => {
    reintento = null;
    initRabbitMQ();
  }, REINTENTO_MS);
  reintento.unref(); // no impide que el proceso termine
}

export async function initRabbitMQ() {
  const url = process.env.RABBITMQ_URL || "amqp://guest:guest@localhost:5672";
  try {
    const connection = await amqp.connect(url);

    connection.on("error", error => {
      console.error("⚠️ [RabbitMQ] Error en la conexion:", error.message);
    });
    connection.on("close", () => {
      channel = null;
      console.warn(`⚠️ [RabbitMQ] Conexion cerrada. Modo degradado; reintento en ${REINTENTO_MS / 1000} s.`);
      programarReintento();
    });

    const nuevoCanal = await connection.createChannel();
    nuevoCanal.on("error", error => {
      console.error("⚠️ [RabbitMQ] Error en el canal:", error.message);
    });
    // Cola durable para sobrevivir caidas del contenedor
    await nuevoCanal.assertQueue(QUEUE_NAME, { durable: true });
    channel = nuevoCanal;
    console.log(`🐇 RabbitMQ Conectado (${ocultarCredenciales(url)}). Productor activo en [${QUEUE_NAME}].`);
  } catch (error) {
    channel = null;
    console.error("⚠️ [RabbitMQ] Broker no disponible. Continuando en modo degradado:", describir(error));
    programarReintento();
  }
}

// Nunca lanza errores ni se espera (no bloquea al usuario).
// Regla CWE-532: el evento NUNCA debe llevar contrasenas ni tokens JWT completos.
export function emitirEventoSeguridad(evento) {
  if (!channel) return;

  try {
    const ahora = new Date();
    const payload = {
      ...evento,
      timestamp: ahora.toISOString(),
      fecha_dia: ahora.toISOString().split("T")[0]
    };
    const buffer = Buffer.from(JSON.stringify(payload));
    // persistent: true indica a RabbitMQ resguardar el mensaje en disco
    const aceptado = channel.sendToQueue(QUEUE_NAME, buffer, { persistent: true });
    if (!aceptado) {
      console.warn("⚠️ [RabbitMQ] Buffer del canal lleno: el evento queda en espera (contrapresion).");
    }
  } catch (err) {
    console.error("❌ Error no bloqueante al encolar evento:", err.message);
  }
}
