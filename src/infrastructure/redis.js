import { createClient } from "redis";

const redisUrl = process.env.REDIS_URL || "redis://:password123@localhost:6379";
const url = new URL(redisUrl);
const esTls = url.protocol === "rediss:";

export const redisClient = createClient({
  url: redisUrl,
  ...(esTls ? { socket: { servername: url.hostname } } : {})
});

redisClient.on("error", error => {
  console.error("Error de Redis:", error.message);
});

export async function conectarRedis() {
  try {
    await redisClient.connect();
    console.log("Redis conectado correctamente:", redisUrl.replace(/\/\/[^@/]*@/, "//***@"));
  } catch (error) {
    console.error("No se pudo conectar a Redis:", error.message);
    process.exit(1);
  }
}
