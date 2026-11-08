// Carga los catalogos iniciales (monedas, estados de pedido, escuelas) y un
// juego de datos de demo multiempresa: una escuela con su admin, un negocio con
// su JEFE, una cafeteria con su VENDEDOR, un CLIENTE y el menu real.
//
// Tambien migra datos creados antes de la version multiempresa (usuarios sin
// rol, escuelas sin codigo de invitacion, cafeterias sin negocio).
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
  NegocioModel,
  CafeteriaModel,
  UsuarioModel,
  ProductoModel
} from "./infrastructure/mongoose-models.js";
import { ROLES } from "./domain/roles.js";
import { generarCodigoInvitacion } from "./resolvers/comun.js";
import { neo4jDriver, conectarNeo4j } from "./infrastructure/neo4j.js";
import { reconstruirGrafo } from "./infrastructure/grafo.js";

const monedas = [
  { codigo: "MXN", nombre: "Peso mexicano", simbolo: "$", decimales: 2, activa: true },
  { codigo: "USD", nombre: "Dolar estadounidense", simbolo: "US$", decimales: 2, activa: true },
  { codigo: "JPY", nombre: "Yen japones", simbolo: "¥", decimales: 0, activa: true }
];

// Cada estado dice a cuales puede pasar. Agregar un estado nuevo es agregar
// una fila aqui, sin tocar el codigo de los resolvers.
//
//   PENDIENTE -> ACEPTADO -> EN_PREPARACION -> LISTO -> ENTREGADO
//        \-----------\-> CANCELADO
const estadosPedido = [
  {
    clave: "PENDIENTE",
    nombre: "Pendiente",
    orden: 1,
    esInicial: true,
    esFinal: false,
    transiciones: ["ACEPTADO", "CANCELADO"]
  },
  {
    clave: "ACEPTADO",
    nombre: "Aceptado",
    orden: 2,
    esInicial: false,
    esFinal: false,
    transiciones: ["EN_PREPARACION", "CANCELADO"]
  },
  {
    clave: "EN_PREPARACION",
    nombre: "En preparacion",
    orden: 3,
    esInicial: false,
    esFinal: false,
    transiciones: ["LISTO"]
  },
  {
    clave: "LISTO",
    nombre: "Listo para recoger",
    orden: 4,
    esInicial: false,
    esFinal: false,
    transiciones: ["ENTREGADO"]
  },
  {
    clave: "ENTREGADO",
    nombre: "Entregado",
    orden: 5,
    esInicial: false,
    esFinal: true,
    transiciones: []
  },
  {
    clave: "CANCELADO",
    nombre: "Cancelado",
    orden: 6,
    esInicial: false,
    esFinal: true,
    transiciones: []
  }
];

// Ajusta nombre, clave y ciudad a los reales de tu escuela.
const escuelas = [{ clave: "ULSA", nombre: "ULSA", ciudad: "Chihuahua", activa: true }];

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

// Migracion: escuelas creadas antes de multiempresa no tienen ciudad ni codigo
for (const escuela of await EscuelaModel.find({ codigoInvitacion: { $exists: false } })) {
  await EscuelaModel.updateOne(
    { _id: escuela._id },
    {
      $set: {
        codigoInvitacion: generarCodigoInvitacion(escuela.clave),
        ciudad: escuela.ciudad || "Sin ciudad"
      }
    }
  );
}

// Se imprimen los ids y codigos para usarlos en la demo
const escuelasEnBase = await EscuelaModel.find({}).sort({ clave: 1 });
for (const escuela of escuelasEnBase) {
  console.log(`  Escuela ${escuela.clave}: id = ${escuela._id}, codigo de invitacion = ${escuela.codigoInvitacion}`);
}

// ---- Usuarios de demo (uno por rol, todos con la misma contrasena) ----
const DEMO_PASSWORD = "demo123";
const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
const LIGAS = ["escuelaId", "negocioId", "cafeteriaId"];

// Crea o actualiza un usuario. Las ligas que no aplican a su rol se borran.
async function usuarioDemo(correo, nombre, ligas) {
  const existente = await UsuarioModel.findOne({ correo });
  const _id = existente?._id ?? new mongoose.Types.ObjectId();
  const $unset = Object.fromEntries(LIGAS.filter(l => !ligas[l]).map(l => [l, ""]));
  await UsuarioModel.updateOne(
    { correo },
    { $set: { nombre, passwordHash, ...ligas }, $unset, $setOnInsert: { _id } },
    { upsert: true }
  );
  return _id;
}

const escuelaDemo = await EscuelaModel.findOne({ clave: escuelas[0].clave });

// El JEFE y su negocio se apuntan entre si: se reserva el id del JEFE primero
const correoJefe = "jefe@ulsa.mx";
const jefeExistente = await UsuarioModel.findOne({ correo: correoJefe });
const jefeId = jefeExistente?._id ?? new mongoose.Types.ObjectId();
const negocio = await NegocioModel.findOneAndUpdate(
  { nombre: "Los Latosos del Chef" },
  { $set: { duenoId: jefeId, activo: true }, $addToSet: { escuelaIds: escuelaDemo._id } },
  { upsert: true, new: true }
);

const cafeteria = await CafeteriaModel.findOneAndUpdate(
  { escuelaId: escuelaDemo._id, nombre: "Cafetería Los Latosos del Chef ULSA" },
  {
    $set: { negocioId: negocio._id },
    $setOnInsert: { activa: true, ubicacion: "Edificio central, planta baja" }
  },
  { upsert: true, new: true }
);

const usuariosDemo = [
  ["admin@cafeenlinea.mx", "Admin Plataforma", { rol: ROLES.ADMIN_PLATAFORMA }],
  ["admin@ulsa.mx", "Admin ULSA", { rol: ROLES.ADMIN_ESCUELA, escuelaId: escuelaDemo._id }],
  [correoJefe, "Jefe Latosos", { rol: ROLES.JEFE, escuelaId: escuelaDemo._id, negocioId: negocio._id }],
  ["vendedor@ulsa.mx", "Vendedor Latosos", {
    rol: ROLES.VENDEDOR, escuelaId: escuelaDemo._id, negocioId: negocio._id, cafeteriaId: cafeteria._id
  }],
  ["demo@ulsa.mx", "Usuario Demo", { rol: ROLES.CLIENTE, escuelaId: escuelaDemo._id }]
];
for (const [correo, nombre, ligas] of usuariosDemo) {
  await usuarioDemo(correo, nombre, ligas);
}

// Migracion: cafeterias sin negocio pasan al negocio demo (y su escuela tambien)
const cafeteriasSinNegocio = await CafeteriaModel.find({ negocioId: { $exists: false } });
for (const huerfana of cafeteriasSinNegocio) {
  await CafeteriaModel.updateOne({ _id: huerfana._id }, { $set: { negocioId: negocio._id } });
  await NegocioModel.updateOne({ _id: negocio._id }, { $addToSet: { escuelaIds: huerfana.escuelaId } });
  console.log(`  Migrada: cafeteria "${huerfana.nombre}" asignada al negocio "${negocio.nombre}"`);
}

// Migracion: usuarios sin rol eran compradores ligados a una cafeteria.
// Ahora son CLIENTE de la escuela de esa cafeteria.
const usuariosSinRol = await UsuarioModel.find({ rol: { $exists: false } });
for (const usuario of usuariosSinRol) {
  const suCafeteria = usuario.cafeteriaId ? await CafeteriaModel.findById(usuario.cafeteriaId) : null;
  await UsuarioModel.updateOne(
    { _id: usuario._id },
    {
      $set: { rol: ROLES.CLIENTE, escuelaId: suCafeteria?.escuelaId ?? escuelaDemo._id },
      $unset: { cafeteriaId: "" }
    }
  );
}
if (usuariosSinRol.length) {
  console.log(`  Migrados: ${usuariosSinRol.length} usuario(s) sin rol ahora son CLIENTE`);
}

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
// Minutos aproximados que tarda cada tipo de platillo (para la hora de recogida)
const TIEMPO_PREPARACION = {
  "Café": 3, "Bebidas": 1, "Licuados": 4, "Desayunos de huevos": 10, "Burritos": 6,
  "Tacos": 8, "Molletes": 7, "Guisados": 5, "Chilaquiles": 10, "Sándwiches": 5,
  "Ensaladas": 6, "Combos": 8, "Extras": 1
};

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
        etiqueta: p.etiqueta,
        tiempoPreparacionMin: TIEMPO_PREPARACION[p.categoria] ?? 5
      }
    },
    { upsert: true }
  );
}

console.log(`  Negocio demo: ${negocio.nombre} (id = ${negocio._id})`);
console.log(`  Cafeteria demo: id = ${cafeteria._id}`);
console.log(`  Usuarios demo (contrasena "${DEMO_PASSWORD}"):`);
for (const [correo, , { rol }] of usuariosDemo) {
  console.log(`    ${rol.padEnd(16)} ${correo}`);
}

// Los catalogos y productos pudieron cambiar: se limpia su cache en Redis
await conectarRedis();
await redisClient.del([
  clavesCache.monedas(),
  clavesCache.estadosPedido(),
  clavesCache.productosPorCafeteria(cafeteria._id),
  clavesCache.productosPorReponer(cafeteria._id)
]);
// Copia la estructura multiempresa al grafo de permisos (Neo4j)
await conectarNeo4j();
console.log("Grafo de permisos:", await reconstruirGrafo());
await neo4jDriver.close();

await redisClient.quit();

await mongoose.disconnect();