// Carga los catalogos iniciales (monedas, estados de pedido, escuelas) y un
// juego de datos de demo: una cafeteria, un usuario para login y productos.
//
//   npm run seed
//
// Es repetible: usa "upsert" (actualiza si ya existe, crea si no), asi que
// correrlo dos veces no duplica nada. Solo una persona del equipo necesita
// correrlo contra la base compartida (Atlas).

import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { conectarBaseDatos } from "./infrastructure/db.js";
import { redisClient, conectarRedis } from "./infrastructure/redis.js";
import { clavesCache } from "./infrastructure/cache.js";
import {
  MonedaModel,
  EstadoPedidoModel,
  EscuelaModel,
  CafeteriaModel,
  UsuarioModel,
  ProductoModel
} from "./infrastructure/mongoose-models.js";

const monedas = [
  { codigo: "MXN", nombre: "Peso mexicano", simbolo: "$", decimales: 2, activa: true },
  { codigo: "USD", nombre: "Dolar estadounidense", simbolo: "US$", decimales: 2, activa: true },
  { codigo: "JPY", nombre: "Yen japones", simbolo: "¥", decimales: 0, activa: true }
];

// Cada estado dice a cuales puede pasar. Agregar un estado nuevo (ej. CANCELADO)
// es agregar una fila aqui, sin tocar el codigo de los resolvers.
const estadosPedido = [
  {
    clave: "PENDIENTE",
    nombre: "Pendiente",
    orden: 1,
    esInicial: true,
    esFinal: false,
    transiciones: ["EN_PREPARACION"]
  },
  {
    clave: "EN_PREPARACION",
    nombre: "En preparacion",
    orden: 2,
    esInicial: false,
    esFinal: false,
    transiciones: ["LISTO"]
  },
  {
    clave: "LISTO",
    nombre: "Listo para recoger",
    orden: 3,
    esInicial: false,
    esFinal: false,
    transiciones: ["ENTREGADO"]
  },
  {
    clave: "ENTREGADO",
    nombre: "Entregado",
    orden: 4,
    esInicial: false,
    esFinal: true,
    transiciones: []
  }
];

// Ajusta nombre y clave a los reales de tu escuela.
const escuelas = [{ clave: "ULSA", nombre: "ULSA", activa: true }];

async function cargar(modelo, llave, datos) {
  const operaciones = datos.map(dato => ({
    updateOne: {
      filter: { [llave]: dato[llave] },
      update: { $set: dato },
      upsert: true
    }
  }));
  const resultado = await modelo.bulkWrite(operaciones);
  return { nuevos: resultado.upsertedCount, actualizados: resultado.modifiedCount };
}

await conectarBaseDatos();

const resumen = {
  monedas: await cargar(MonedaModel, "codigo", monedas),
  estadosPedido: await cargar(EstadoPedidoModel, "clave", estadosPedido),
  escuelas: await cargar(EscuelaModel, "clave", escuelas)
};
console.log("Catalogos cargados:", resumen);

// Se imprimen los ids para poder usarlos en registrarCafeteria(escuelaId: ...)
const escuelasEnBase = await EscuelaModel.find({}).sort({ clave: 1 });
for (const escuela of escuelasEnBase) {
  console.log(`  Escuela ${escuela.clave}: id = ${escuela._id}`);
}

// ---- Datos de demo (tambien repetibles) ----
const DEMO_CORREO = "demo@ulsa.mx";
const DEMO_PASSWORD = "demo123";

const escuelaDemo = await EscuelaModel.findOne({ clave: escuelas[0].clave });
const cafeteria = await CafeteriaModel.findOneAndUpdate(
  { escuelaId: escuelaDemo._id, nombre: "Cafeteria Central" },
  { $setOnInsert: { activa: true } },
  { upsert: true, new: true }
);

await UsuarioModel.updateOne(
  { correo: DEMO_CORREO },
  {
    $set: {
      nombre: "Usuario Demo",
      cafeteriaId: cafeteria._id,
      passwordHash: await bcrypt.hash(DEMO_PASSWORD, 10)
    }
  },
  { upsert: true }
);

const productosDemo = [
  { nombre: "Cafe americano", monto: 35, stock: 50 },
  { nombre: "Sandwich de pavo", monto: 65, stock: 4 },
  { nombre: "Jugo de naranja", monto: 30, stock: 20 }
];
for (const p of productosDemo) {
  await ProductoModel.updateOne(
    { cafeteriaId: cafeteria._id, nombre: p.nombre },
    {
      $setOnInsert: {
        precio: { monto: p.monto, moneda: "MXN" },
        disponible: true,
        inventario: { stock: p.stock, puntoReorden: 5, cantidadReposicion: 20 }
      }
    },
    { upsert: true }
  );
}

console.log(`  Cafeteria demo: id = ${cafeteria._id}`);
console.log(`  Usuario demo: ${DEMO_CORREO} / ${DEMO_PASSWORD}`);

// Los catalogos y productos pudieron cambiar: se limpia su cache en Redis
await conectarRedis();
await redisClient.del([
  clavesCache.monedas(),
  clavesCache.estadosPedido(),
  clavesCache.productosPorCafeteria(cafeteria._id),
  clavesCache.productosPorReponer(cafeteria._id)
]);
await redisClient.quit();

await mongoose.disconnect();