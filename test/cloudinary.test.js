import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_UPLOAD_PRESET,
  LIMITE_PERFIL_POR_HORA,
  LIMITE_PRODUCTO_USUARIO_POR_HORA,
  LIMITE_PRODUCTO_CAFETERIA_POR_HORA,
  RATE_LIMIT_TTL_SEGUNDOS,
  generarFirmaSubida,
  validarCredencialesCloudinary,
  verificarLimiteFirma,
  prepararFirmaSubida
} from "../src/infrastructure/cloudinary.js";

// Credenciales ficticias: las pruebas nunca usan valores reales de .env.
const CREDENCIALES_FICTICIAS = {
  CLOUDINARY_CLOUD_NAME: "cloud-ficticia-de-prueba",
  CLOUDINARY_API_KEY: "123456789012345",
  CLOUDINARY_API_SECRET: "secreto-ficticio-que-no-debe-filtrarse-9f8e7d",
  CLOUDINARY_UPLOAD_PRESET: "preset-ficticio-de-prueba"
};

const VARIABLES_CLOUDINARY = Object.keys(CREDENCIALES_FICTICIAS);
let respaldoEnv;

beforeEach(() => {
  respaldoEnv = {};
  for (const nombre of VARIABLES_CLOUDINARY) {
    respaldoEnv[nombre] = process.env[nombre];
    delete process.env[nombre];
  }
});

afterEach(() => {
  for (const nombre of VARIABLES_CLOUDINARY) {
    if (respaldoEnv[nombre] === undefined) {
      delete process.env[nombre];
    } else {
      process.env[nombre] = respaldoEnv[nombre];
    }
  }
});

function usarCredencialesFicticias(extra = {}) {
  Object.assign(process.env, CREDENCIALES_FICTICIAS, extra);
}

// Replica el algoritmo de firma de Cloudinary de forma independiente al SDK:
// parametros ordenados, union con "&" y SHA-1 de la cadena + api_secret.
function firmaEsperada({ folder, timestamp, uploadPreset, apiSecret }) {
  const parametros = [
    ["folder", folder],
    ["timestamp", String(timestamp)],
    ["upload_preset", uploadPreset]
  ].sort((a, b) => a[0].localeCompare(b[0]));

  const cadena = parametros
    .map(([clave, valor]) => `${clave}=${valor}`.replace(/&/g, "%26"))
    .join("&");

  return createHash("sha1").update(cadena + apiSecret).digest("hex");
}

// Doble de prueba de Redis: reproduce la semantica del script Lua de cloudinary.js.
class RedisFalso {
  constructor() {
    this.contadores = new Map();
    this.ttls = new Map();
    this.llamadas = [];
  }

  async eval(script, { keys, arguments: args }) {
    this.llamadas.push({ script, keys: [...keys], arguments: [...args] });

    const actual1 = Number(this.contadores.get(keys[0]) ?? 0);
    if (actual1 >= Number(args[0])) {
      return -1;
    }

    if (keys.length > 1 && keys[1] !== "") {
      const actual2 = Number(this.contadores.get(keys[1]) ?? 0);
      if (actual2 >= Number(args[2])) {
        return -2;
      }
      this.incrementar(keys[1], Number(args[1]));
    }

    this.incrementar(keys[0], Number(args[1]));
    return 1;
  }

  incrementar(clave, ttl) {
    const siguiente = Number(this.contadores.get(clave) ?? 0) + 1;
    this.contadores.set(clave, siguiente);
    this.ttls.set(clave, ttl);
  }

  instantanea() {
    return Object.fromEntries([...this.contadores.entries()].sort());
  }
}

const CAFETERIA_ID = "64b7f0c2e4b0a1a2b3c4d5e6";
const USUARIO_ID = "64b7f0c2e4b0a1a2b3c4d5e7";

test("genera una firma de PRODUCTO con credenciales ficticias y carpeta correcta", () => {
  usarCredencialesFicticias();

  const firma = generarFirmaSubida({
    tipo: "PRODUCTO",
    cafeteriaId: CAFETERIA_ID,
    usuarioId: USUARIO_ID
  });

  assert.equal(firma.folder, `productos/cafeteria_${CAFETERIA_ID}`);
  assert.equal(firma.apiKey, CREDENCIALES_FICTICIAS.CLOUDINARY_API_KEY);
  assert.equal(firma.cloudName, CREDENCIALES_FICTICIAS.CLOUDINARY_CLOUD_NAME);
  assert.equal(firma.uploadPreset, CREDENCIALES_FICTICIAS.CLOUDINARY_UPLOAD_PRESET);
  assert.ok(Number.isInteger(firma.timestamp));
  assert.ok(Math.abs(firma.timestamp - Math.floor(Date.now() / 1000)) <= 5);
  assert.match(firma.signature, /^[a-f0-9]{40}$/);
  assert.equal(
    firma.signature,
    firmaEsperada({
      folder: firma.folder,
      timestamp: firma.timestamp,
      uploadPreset: firma.uploadPreset,
      apiSecret: CREDENCIALES_FICTICIAS.CLOUDINARY_API_SECRET
    })
  );
});

test("usa el preset por defecto cuando CLOUDINARY_UPLOAD_PRESET no esta definido", () => {
  usarCredencialesFicticias();
  delete process.env.CLOUDINARY_UPLOAD_PRESET;

  const firma = generarFirmaSubida({
    tipo: "PRODUCTO",
    cafeteriaId: CAFETERIA_ID,
    usuarioId: USUARIO_ID
  });

  assert.equal(firma.uploadPreset, DEFAULT_UPLOAD_PRESET);
});

test("respeta un CLOUDINARY_UPLOAD_PRESET personalizado", () => {
  usarCredencialesFicticias({ CLOUDINARY_UPLOAD_PRESET: "preset-personalizado" });

  const firma = generarFirmaSubida({
    tipo: "PRODUCTO",
    cafeteriaId: CAFETERIA_ID,
    usuarioId: USUARIO_ID
  });

  assert.equal(firma.uploadPreset, "preset-personalizado");
});

test("la respuesta de la firma no incluye el API Secret", () => {
  usarCredencialesFicticias();

  const firma = generarFirmaSubida({
    tipo: "PRODUCTO",
    cafeteriaId: CAFETERIA_ID,
    usuarioId: USUARIO_ID
  });

  assert.deepEqual(
    Object.keys(firma).sort(),
    ["apiKey", "cloudName", "folder", "signature", "timestamp", "uploadPreset"]
  );
  assert.ok(!JSON.stringify(firma).includes(CREDENCIALES_FICTICIAS.CLOUDINARY_API_SECRET));
});

test("el error por credenciales faltantes no expone el API Secret", () => {
  usarCredencialesFicticias();
  delete process.env.CLOUDINARY_CLOUD_NAME;
  delete process.env.CLOUDINARY_API_KEY;

  assert.throws(
    () => generarFirmaSubida({
      tipo: "PRODUCTO",
      cafeteriaId: CAFETERIA_ID,
      usuarioId: USUARIO_ID
    }),
    error => {
      assert.match(error.message, /CLOUDINARY_CLOUD_NAME/);
      assert.match(error.message, /CLOUDINARY_API_KEY/);
      assert.ok(!error.message.includes(CREDENCIALES_FICTICIAS.CLOUDINARY_API_SECRET));
      return true;
    }
  );
});

test("validarCredencialesCloudinary acepta credenciales ficticias completas", () => {
  usarCredencialesFicticias();
  assert.doesNotThrow(() => validarCredencialesCloudinary());
});

test("limite de firmas de PERFIL: permite 5 y rechaza la sexta sin filtrar el secreto", async () => {
  usarCredencialesFicticias();
  const redis = new RedisFalso();

  for (let i = 0; i < LIMITE_PERFIL_POR_HORA; i += 1) {
    await verificarLimiteFirma({ tipo: "PERFIL", usuarioId: USUARIO_ID, clienteRedis: redis });
  }

  await assert.rejects(
    () => verificarLimiteFirma({ tipo: "PERFIL", usuarioId: USUARIO_ID, clienteRedis: redis }),
    error => {
      assert.equal(error.extensions.code, "TOO_MANY_REQUESTS");
      assert.equal(error.extensions.http.status, 429);
      assert.ok(!error.message.includes(CREDENCIALES_FICTICIAS.CLOUDINARY_API_SECRET));
      return true;
    }
  );
});

test("limite individual de PRODUCTO: permite 20 y rechaza la solicitud 21", async () => {
  usarCredencialesFicticias();
  const redis = new RedisFalso();

  for (let i = 0; i < LIMITE_PRODUCTO_USUARIO_POR_HORA; i += 1) {
    await verificarLimiteFirma({
      tipo: "PRODUCTO",
      usuarioId: USUARIO_ID,
      cafeteriaId: CAFETERIA_ID,
      clienteRedis: redis
    });
  }

  await assert.rejects(
    () => verificarLimiteFirma({
      tipo: "PRODUCTO",
      usuarioId: USUARIO_ID,
      cafeteriaId: CAFETERIA_ID,
      clienteRedis: redis
    }),
    error => error.extensions.code === "TOO_MANY_REQUESTS" && error.extensions.http.status === 429
  );
});

test("limite global de PRODUCTO por cafeteria: permite 60 entre usuarios y rechaza la 61", async () => {
  usarCredencialesFicticias();
  const redis = new RedisFalso();

  for (let i = 0; i < LIMITE_PRODUCTO_CAFETERIA_POR_HORA; i += 1) {
    await verificarLimiteFirma({
      tipo: "PRODUCTO",
      usuarioId: `usuario-${i}`,
      cafeteriaId: CAFETERIA_ID,
      clienteRedis: redis
    });
  }

  await assert.rejects(
    () => verificarLimiteFirma({
      tipo: "PRODUCTO",
      usuarioId: "usuario-61",
      cafeteriaId: CAFETERIA_ID,
      clienteRedis: redis
    }),
    error => {
      assert.equal(error.extensions.code, "TOO_MANY_REQUESTS");
      assert.match(error.message, /limite global/i);
      return true;
    }
  );
});

test("un rechazo de rate limit no incrementa contadores", async () => {
  usarCredencialesFicticias();
  const redis = new RedisFalso();

  for (let i = 0; i < LIMITE_PRODUCTO_USUARIO_POR_HORA; i += 1) {
    await verificarLimiteFirma({
      tipo: "PRODUCTO",
      usuarioId: USUARIO_ID,
      cafeteriaId: CAFETERIA_ID,
      clienteRedis: redis
    });
  }

  const antes = redis.instantanea();
  await assert.rejects(() => verificarLimiteFirma({
    tipo: "PRODUCTO",
    usuarioId: USUARIO_ID,
    cafeteriaId: CAFETERIA_ID,
    clienteRedis: redis
  }));
  assert.deepEqual(redis.instantanea(), antes);
});

test("construye las claves y argumentos correctos para Redis", async () => {
  usarCredencialesFicticias();
  const redis = new RedisFalso();

  await verificarLimiteFirma({
    tipo: "PRODUCTO",
    usuarioId: USUARIO_ID,
    cafeteriaId: CAFETERIA_ID,
    clienteRedis: redis
  });

  assert.deepEqual(redis.llamadas[0].keys, [
    `ratelimit:firma:prod:usr:${USUARIO_ID}:cafe:${CAFETERIA_ID}`,
    `ratelimit:firma:prod:cafe:${CAFETERIA_ID}`
  ]);
  assert.deepEqual(redis.llamadas[0].arguments, [
    String(LIMITE_PRODUCTO_USUARIO_POR_HORA),
    String(RATE_LIMIT_TTL_SEGUNDOS),
    String(LIMITE_PRODUCTO_CAFETERIA_POR_HORA)
  ]);

  await verificarLimiteFirma({
    tipo: "PERFIL",
    usuarioId: USUARIO_ID,
    clienteRedis: redis
  });

  assert.deepEqual(redis.llamadas[1].keys, [`ratelimit:firma:perfil:${USUARIO_ID}`]);
  assert.deepEqual(redis.llamadas[1].arguments, [
    String(LIMITE_PERFIL_POR_HORA),
    String(RATE_LIMIT_TTL_SEGUNDOS)
  ]);
});

test("prepararFirmaSubida valida credenciales antes de consumir Redis", async () => {
  usarCredencialesFicticias();
  delete process.env.CLOUDINARY_CLOUD_NAME;

  const redis = new RedisFalso();

  await assert.rejects(
    () => prepararFirmaSubida({
      tipo: "PRODUCTO",
      cafeteriaId: CAFETERIA_ID,
      usuarioId: USUARIO_ID,
      clienteRedis: redis
    }),
    error => {
      assert.match(error.message, /CLOUDINARY_CLOUD_NAME/);
      assert.ok(!error.message.includes(CREDENCIALES_FICTICIAS.CLOUDINARY_API_SECRET));
      return true;
    }
  );

  assert.equal(redis.llamadas.length, 0);
});

test("prepararFirmaSubida consume Redis y devuelve la firma cuando todo esta configurado", async () => {
  usarCredencialesFicticias();
  const redis = new RedisFalso();

  const firma = await prepararFirmaSubida({
    tipo: "PRODUCTO",
    cafeteriaId: CAFETERIA_ID,
    usuarioId: USUARIO_ID,
    clienteRedis: redis
  });

  assert.equal(redis.llamadas.length, 1);
  assert.equal(firma.folder, `productos/cafeteria_${CAFETERIA_ID}`);
  assert.match(firma.signature, /^[a-f0-9]{40}$/);
});

test("escenario d) REDIS_URL invalida sin REDIS_TEST_URL: el modulo se carga y usa el cliente inyectado", () => {
  const moduloCloudinary = new URL("../src/infrastructure/cloudinary.js", import.meta.url).href;
  const guion = `
    import assert from "node:assert/strict";
    import { verificarLimiteFirma } from ${JSON.stringify(moduloCloudinary)};
    const falso = { llamadas: 0, async eval() { this.llamadas += 1; return 1; } };
    await verificarLimiteFirma({ tipo: "PERFIL", usuarioId: "u", clienteRedis: falso });
    assert.equal(falso.llamadas, 1);
    console.log("DECOUPLING_OK");
  `;

  const entorno = { ...process.env, REDIS_URL: "esto-no-es-una-url" };
  delete entorno.REDIS_TEST_URL;

  const salida = execFileSync(process.execPath, ["--input-type=module", "-e", guion], {
    env: entorno,
    encoding: "utf8"
  });

  assert.match(salida, /DECOUPLING_OK/);
});

test("escenario e) con cliente Redis inyectado no se intenta conectar a Redis real", async () => {
  usarCredencialesFicticias();
  const original = process.env.REDIS_URL;
  process.env.REDIS_URL = "esto-no-es-una-url";

  try {
    const redis = new RedisFalso();

    await verificarLimiteFirma({ tipo: "PERFIL", usuarioId: USUARIO_ID, clienteRedis: redis });

    assert.equal(redis.llamadas.length, 1);
  } finally {
    if (original === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = original;
    }
  }
});
