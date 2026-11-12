import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import {
  LIMITE_PERFIL_POR_HORA,
  LIMITE_PRODUCTO_USUARIO_POR_HORA,
  RATE_LIMIT_TTL_SEGUNDOS,
  verificarLimiteFirma
} from "../src/infrastructure/cloudinary.js";

// Prueba de integracion opcional. Solo usa REDIS_TEST_URL:
// - No usa ninguna otra variable de Redis.
// - No contiene URLs ni contrasenas por defecto.
// - Si la variable no existe, es invalida o Redis no responde, la prueba se omite.
const TIEMPO_MAXIMO_CONEXION_MS = 1500;

function urlDePrueba() {
  return process.env.REDIS_TEST_URL;
}

// Cierra el cliente por cualquier via disponible, sin propagar errores.
async function cerrarCliente(cliente) {
  if (!cliente) {
    return;
  }

  try {
    await cliente.quit();
  } catch {
    try {
      await cliente.disconnect();
    } catch {
      try {
        cliente.destroy();
      } catch {
        // El cliente ya estaba cerrado.
      }
    }
  }
}

async function conectarSiDisponible(url = urlDePrueba()) {
  if (!url) {
    return null;
  }

  let cliente;
  try {
    cliente = createClient({ url });
  } catch {
    // URL invalida: no se pudo crear el cliente, la prueba se omite.
    return null;
  }

  cliente.on("error", () => {});

  let temporizador;
  const tiempoAgotado = new Promise((_, rechazar) => {
    temporizador = setTimeout(
      () => rechazar(new Error("Tiempo de conexion agotado")),
      TIEMPO_MAXIMO_CONEXION_MS
    );
  });

  const conexion = cliente.connect();

  try {
    await Promise.race([conexion, tiempoAgotado]);
    return cliente;
  } catch {
    // Si la conexion se resuelve despues del tiempo limite, se cierra para no
    // dejar una conexion tardia abierta.
    conexion.then(() => cerrarCliente(cliente), () => {});
    await cerrarCliente(cliente);
    return null;
  } finally {
    clearTimeout(temporizador);
  }
}

// Escenarios de omision de la prueba real (a, b, c).
test("escenario a) REDIS_TEST_URL ausente: la prueba real se omite sin conectar", async () => {
  const cliente = await conectarSiDisponible(undefined);
  assert.equal(cliente, null);
});

test("escenario b) REDIS_TEST_URL invalida: se omite sin lanzar y sin dejar conexion", async () => {
  const cliente = await conectarSiDisponible("esto-no-es-una-url-valida");
  assert.equal(cliente, null);
});

test("escenario c) REDIS_TEST_URL valida pero Redis no disponible: se omite por timeout", async () => {
  const cliente = await conectarSiDisponible("redis://127.0.0.1:6399");
  assert.equal(cliente, null);
});

test("rate limit real en Redis usando exclusivamente REDIS_TEST_URL", async t => {
  const cliente = await conectarSiDisponible();
  if (!cliente) {
    t.skip("REDIS_TEST_URL no definida o Redis no disponible");
    return;
  }

  const usuarioPerfil = `test-perfil-${randomUUID()}`;
  const usuarioProducto = `test-producto-${randomUUID()}`;
  const cafeteriaId = `test-cafe-${randomUUID()}`;

  const claves = [
    `ratelimit:firma:perfil:${usuarioPerfil}`,
    `ratelimit:firma:prod:usr:${usuarioProducto}:cafe:${cafeteriaId}`,
    `ratelimit:firma:prod:cafe:${cafeteriaId}`
  ];

  try {
    await cliente.del(...claves);

    for (let i = 0; i < LIMITE_PERFIL_POR_HORA; i += 1) {
      await verificarLimiteFirma({
        tipo: "PERFIL",
        usuarioId: usuarioPerfil,
        clienteRedis: cliente
      });
    }

    const ttl = await cliente.ttl(`ratelimit:firma:perfil:${usuarioPerfil}`);
    assert.ok(ttl > 0 && ttl <= RATE_LIMIT_TTL_SEGUNDOS);

    await assert.rejects(
      () => verificarLimiteFirma({
        tipo: "PERFIL",
        usuarioId: usuarioPerfil,
        clienteRedis: cliente
      }),
      error => error.extensions?.code === "TOO_MANY_REQUESTS"
    );

    for (let i = 0; i < LIMITE_PRODUCTO_USUARIO_POR_HORA; i += 1) {
      await verificarLimiteFirma({
        tipo: "PRODUCTO",
        usuarioId: usuarioProducto,
        cafeteriaId,
        clienteRedis: cliente
      });
    }

    await assert.rejects(
      () => verificarLimiteFirma({
        tipo: "PRODUCTO",
        usuarioId: usuarioProducto,
        cafeteriaId,
        clienteRedis: cliente
      }),
      error => error.extensions?.code === "TOO_MANY_REQUESTS"
    );
  } finally {
    try {
      await cliente.del(...claves);
    } catch {
      // La limpieza de claves no debe impedir el cierre del cliente.
    }
    await cerrarCliente(cliente);
  }
});
