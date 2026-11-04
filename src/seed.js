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
  { escuelaId: escuelaDemo._id, nombre: "Cafetería Los Latosos del Chef ULSA" },
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

// ---------------------------------------------------------------------------
// MENU REAL: Cafeteria Los Latosos del Chef ULSA (transcrito del menu impreso).
//
// Como agregar o cambiar productos: edita esta lista y corre `npm run seed`.
//  - categoria: cada categoria distinta es una seccion del menu en la app.
//    Dos son especiales: "Combos" (carrusel de combos) y "Extras" (extras que
//    se cobran aparte al elegir un producto).
//  - destacado: true  -> sale en el carrusel de arriba.
//  - etiqueta: insignia corta (ej. "Fuente de proteina").
//  - imagenUrl: URL de Cloudinary (Media Library > Copy URL). Vacia = sin foto.
// El precio y el stock solo se guardan cuando el producto se crea por primera vez;
// para cambiarlos despues, editalos en Atlas. El resto se actualiza en cada seed.
// El stock inicial es de ejemplo: ajustalo en Atlas a lo que hay realmente.
// ---------------------------------------------------------------------------
const STOCK_INICIAL = 50;
const prod = (categoria, nombre, monto, descripcion = "", extra = {}) => ({
  nombre, monto, stock: STOCK_INICIAL, descripcion, categoria,
  imagenUrl: "", destacado: false, etiqueta: "", ...extra
});

const HUEVOS = "Incluye frijoles, pan o tortilla (3 huevos por orden).";
const COMBO_BEBIDA = "Incluye café americano o té helado.";

const productosMenu = [
  // ---- Café ----
  prod("Café", "Latte", 65, "Suave, cremoso y con el perfecto toque de café.", { etiqueta: "Energía balanceada" }),
  prod("Café", "Americano con leche", 55, "Clásico, reconfortante y lleno de sabor.", { etiqueta: "Buena fuente de calcio" }),
  prod("Café", "Americano", 30, "Intenso y natural, para los amantes del café puro.", { etiqueta: "Antioxidantes naturales" }),

  // ---- Bebidas ----
  prod("Bebidas", "Agua natural 1 L", 20),
  prod("Bebidas", "Agua natural 500 ml", 15),
  prod("Bebidas", "Agua mineral 1 L", 30),
  prod("Bebidas", "Agua de sabor 1 L", 35),
  prod("Bebidas", "Agua mineralizada con sabor 1 L", 35),
  prod("Bebidas", "Agua de sabor 500 ml", 25),
  prod("Bebidas", "Té helado (vaso 16 oz)", 25),

  // ---- Licuados ----
  prod("Licuados", "Licuado de plátano", 45),
  prod("Licuados", "Licuado de fresa", 45),
  prod("Licuados", "Licuado de mango", 45),

  // ---- Desayunos de huevos ----
  prod("Desayunos de huevos", "Huevos al gusto", 75, HUEVOS),
  prod("Desayunos de huevos", "Huevos a la mexicana", 75, HUEVOS),
  prod("Desayunos de huevos", "Huevos con tocino", 75, HUEVOS),
  prod("Desayunos de huevos", "Huevos con chorizo", 75, HUEVOS),
  prod("Desayunos de huevos", "Omelette a tu gusto", 80, "Con jamón, chorizo o queso a tu gusto.",
    { destacado: true, etiqueta: "Energía completa" }),

  // ---- Burritos ----
  prod("Burritos", "Burrito de asada", 65),
  prod("Burritos", "Burrito alambre con pollo", 35, "", { destacado: true, etiqueta: "Fuente de proteína" }),
  prod("Burritos", "Burrito alambre de res", 35),
  prod("Burritos", "Burrito de picadillo con papas", 35),
  prod("Burritos", "Burrito de frijoles con queso", 35),
  prod("Burritos", "Burrito de papas con chorizo", 35),
  prod("Burritos", "Burrito de costilla", 35),
  prod("Burritos", "Burrito de chile colorado", 35),

  // ---- Tacos ----
  prod("Tacos", "Tacos de rib eye (4)", 110, "Orden de 4 tacos."),
  prod("Tacos", "Tacos de sirloin (4)", 110, "Orden de 4 tacos."),
  prod("Tacos", "Tacos de bistec (4)", 110, "Orden de 4 tacos.", { destacado: true, etiqueta: "Proteína de calidad" }),
  prod("Tacos", "Tacos de guisado (5)", 80, "Orden de 5 tacos.", { destacado: true, etiqueta: "Caseros y sabrosos" }),

  // ---- Molletes ----
  prod("Molletes", "Molletes sencillos", 35),
  prod("Molletes", "Molletes con huevo", 55),
  prod("Molletes", "Molletes con guisado", 65),

  // ---- Guisados ----
  prod("Guisados", "Guisado de carne asada", 35),
  prod("Guisados", "Guisado de costilla en salsa verde", 35),
  prod("Guisados", "Guisado de picadillo", 35),
  prod("Guisados", "Guisado de alambre de pollo", 35),
  prod("Guisados", "Guisado de alambre de res", 35),
  prod("Guisados", "Guisado de frijoles con queso", 35),
  prod("Guisados", "Guisado de chile colorado", 35),

  // ---- Chilaquiles ----
  prod("Chilaquiles", "Chilaquiles con pollo", 70),
  prod("Chilaquiles", "Chilaquiles con huevo", 80),
  prod("Chilaquiles", "Chilaquiles con pollo y guisado", 90),

  // ---- Sándwiches ----
  prod("Sándwiches", "Sándwich de jamón", 65, "Con queso y verdura a tu gusto. En sándwich o cuernito."),
  prod("Sándwiches", "Sándwich de pechuga de pavo", 65, "Con queso y verdura a tu gusto. En sándwich o cuernito."),

  // ---- Ensaladas ----
  prod("Ensaladas", "Ensalada César con pollo", 100, "Fresca y nutritiva.", { destacado: true, etiqueta: "Alta en fibra" }),
  prod("Ensaladas", "Ensalada César sin pollo", 70, "Fresca y nutritiva."),
  prod("Ensaladas", "Ensalada jardín", 60, "Fresca y nutritiva."),

  // ---- Combos (categoria especial) ----
  prod("Combos", "Combo 1", 55, "Burrito + bebida. " + COMBO_BEBIDA),
  prod("Combos", "Combo 2", 95, "Chilaquiles + bebida. " + COMBO_BEBIDA),
  prod("Combos", "Combo 3", 90, "Tacos (4) + bebida. " + COMBO_BEBIDA),
  prod("Combos", "Combo 4", 110, "Ensalada + bebida. " + COMBO_BEBIDA),
  prod("Combos", "Combo 5", 55, "Molletes + bebida. " + COMBO_BEBIDA),

  // ---- Extras (categoria especial) ----
  prod("Extras", "Bebida de soya", 15),
  prod("Extras", "Bebida de almendras", 15),
  prod("Extras", "Bebida de avena", 15),
  prod("Extras", "Queso extra", 15)
];
for (const p of productosMenu) {
  await ProductoModel.updateOne(
    { cafeteriaId: cafeteria._id, nombre: p.nombre },
    {
      $setOnInsert: {
        precio: { monto: p.monto, moneda: "MXN" },
        disponible: true,
        inventario: { stock: p.stock, puntoReorden: 5, cantidadReposicion: 20 }
      },
      // Datos del menu: se actualizan en cada seed (tambien en productos que ya existian)
      $set: {
        descripcion: p.descripcion,
        categoria: p.categoria,
        imagenUrl: p.imagenUrl,
        destacado: p.destacado,
        etiqueta: p.etiqueta
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