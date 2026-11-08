import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import {
  MonedaModel,
  EstadoPedidoModel,
  EscuelaModel,
  CafeteriaModel,
  UsuarioModel,
  ProductoModel,
  PedidoModel
} from "../infrastructure/mongoose-models.js";
import {
  Moneda,
  EstadoPedido,
  Inventario,
  Producto,
  ItemPedido,
  Pedido,
  calcularTiempoEstimado,
  validarHoraRecogida
} from "../domain/entities.js";
import {
  agregarACola,
  quitarDeCola,
  estadoCola,
  posicionEnCola,
  CAPACIDAD_PARALELA
} from "../infrastructure/cola.js";
import { notificar, leerNotificaciones } from "../infrastructure/notificaciones.js";
import { obtenerConCache, invalidarCache, clavesCache } from "../infrastructure/cache.js";
import {
  iniciarSesion,
  cerrarSesion,
  requerirSesion,
  noAutorizado,
  prohibido
} from "../infrastructure/auth.js";
import { autorizar, puede } from "../infrastructure/autorizacion.js";
import { sincronizarUsuario, sincronizarSinFallar } from "../infrastructure/grafo.js";
import { ROLES } from "../domain/roles.js";
import {
  datoInvalido,
  enTransaccion,
  manejarDuplicado,
  normalizarClave,
  validarId,
  mapEscuela,
  mapCafeteria,
  mapUsuario,
  crearCuenta
} from "./comun.js";
import { resolversMultiempresa } from "./multiempresa.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// El reporte de mas vendidos solo cuenta pedidos con este estado del catalogo.
// (No se usa "cualquier estado final" porque un futuro CANCELADO tambien seria final.)
const ESTADO_VENTA_COMPLETADA = "ENTREGADO";

// -------------------------------------------------
// Mappers: documento de Mongo -> forma que expone GraphQL
// -------------------------------------------------
function mapMoneda(doc) {
  return {
    id: doc._id,
    codigo: doc.codigo,
    nombre: doc.nombre,
    simbolo: doc.simbolo,
    decimales: doc.decimales,
    activa: doc.activa
  };
}

function mapEstadoPedido(doc) {
  return {
    id: doc._id,
    clave: doc.clave,
    nombre: doc.nombre,
    orden: doc.orden,
    esInicial: doc.esInicial,
    esFinal: doc.esFinal,
    transiciones: doc.transiciones
  };
}

function mapDinero(dinero) {
  return { monto: dinero.monto, moneda: dinero.moneda };
}

function mapInventario(inventario) {
  const dominio = new Inventario(
    inventario.stock,
    inventario.puntoReorden,
    inventario.cantidadReposicion
  );
  return {
    stock: dominio.stock,
    puntoReorden: dominio.puntoReorden,
    cantidadReposicion: dominio.cantidadReposicion,
    requiereReposicion: dominio.requiereReposicion()
  };
}

function mapProducto(doc) {
  return {
    id: doc._id,
    nombre: doc.nombre,
    precio: mapDinero(doc.precio),
    disponible: doc.disponible,
    inventario: mapInventario(doc.inventario),
    descripcion: doc.descripcion ?? "",
    categoria: doc.categoria || "Menu",
    imagenUrl: doc.imagenUrl || null,
    destacado: doc.destacado ?? false,
    etiqueta: doc.etiqueta ?? "",
    tiempoPreparacionMin: doc.tiempoPreparacionMin ?? 5,
    agotado: !doc.disponible || doc.inventario.stock <= 0,
    cafeteriaId: doc.cafeteriaId
  };
}

// Valida y normaliza un precio contra el catalogo de monedas.
async function precioValidado(precio) {
  const moneda = await obtenerMonedaDominio(precio.moneda);
  moneda.validarMonto(precio.monto);
  return { monto: precio.monto, moneda: moneda.codigo };
}

// Convierte los errores de validacion de Mongoose en un mensaje claro para la app.
function validacionMongoose(error) {
  if (error?.name === "ValidationError") {
    return datoInvalido(Object.values(error.errors)[0].message);
  }
  return error;
}

function mapPedido(doc) {
  return {
    id: doc._id,
    usuarioId: doc.usuarioId,
    cafeteriaId: doc.cafeteriaId,
    items: doc.items.map(item => ({
      productoId: item.productoId,
      nombreProducto: item.nombreProducto,
      precioUnitario: mapDinero(item.precioUnitario),
      cantidad: item.cantidad
    })),
    total: mapDinero(doc.total),
    estado: doc.estado,
    notas: doc.notas ?? "",
    tiempoEstimadoMin: doc.tiempoEstimadoMin ?? null,
    horaRecogida: doc.horaRecogida ? doc.horaRecogida.toISOString() : null,
    // Pedido.codigoRecogida decide si se muestra (solo al dueno del pedido)
    codigoRecogida: doc.codigoRecogida ?? null,
    historial: (doc.historial ?? []).map(cambio => ({
      estado: cambio.estado,
      fecha: cambio.fecha.toISOString(),
      usuarioId: cambio.usuarioId ?? null
    })),
    creadoEn: doc.createdAt ? doc.createdAt.toISOString() : null
  };
}

// -------------------------------------------------
// Pickup
// -------------------------------------------------
const ZONA_HORARIA = process.env.ZONA_HORARIA || "America/Chihuahua";
// Estados en los que la cocina ya no trabaja en el pedido (sale de la cola)
const ESTADOS_FUERA_DE_COLA = ["LISTO", "ENTREGADO", "CANCELADO"];

const horaLegible = fecha =>
  fecha.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: ZONA_HORARIA });

function mensajeDeEstado(pedido) {
  switch (pedido.estado) {
    case "ACEPTADO":
      return pedido.horaRecogida
        ? `La cafeteria acepto tu pedido. Recogelo a las ${horaLegible(pedido.horaRecogida)}.`
        : "La cafeteria acepto tu pedido.";
    case "EN_PREPARACION":
      return "Tu pedido se esta preparando.";
    case "LISTO":
      return pedido.codigoRecogida
        ? `¡Tu pedido esta listo! Muestra el codigo ${pedido.codigoRecogida} al recogerlo.`
        : "¡Tu pedido esta listo para recoger!";
    case "ENTREGADO":
      return "Pedido entregado. ¡Buen provecho!";
    case "CANCELADO":
      return "Tu pedido fue cancelado y no se te cobrara.";
    default:
      return `Tu pedido cambio a ${pedido.estado}.`;
  }
}

// Regresa al inventario lo que el pedido habia descontado
async function devolverStock(pedido, session) {
  for (const item of pedido.items) {
    await ProductoModel.updateOne(
      { _id: item.productoId },
      { $inc: { "inventario.stock": item.cantidad } },
      { session }
    );
  }
}

// Valida y aplica un cambio de estado; si es CANCELADO devuelve el stock en
// la misma transaccion. Despues saca el pedido de la cola y avisa al comprador.
async function cambiarEstado(pedido, claveNueva, usuarioId) {
  const estadoActual = await obtenerEstadoDominio(pedido.estado);
  const estadoNuevo = await obtenerEstadoDominio(claveNueva);
  estadoActual.validarTransicion(estadoNuevo.clave);

  pedido.estado = estadoNuevo.clave;
  pedido.historial.push({ estado: estadoNuevo.clave, fecha: new Date(), usuarioId });

  let guardado;
  if (estadoNuevo.clave === "CANCELADO") {
    guardado = await enTransaccion(async session => {
      await devolverStock(pedido, session);
      return pedido.save({ session });
    });
    await invalidarProductos(pedido.cafeteriaId, pedido.items.map(i => String(i.productoId)));
  } else {
    guardado = await pedido.save();
  }

  if (ESTADOS_FUERA_DE_COLA.includes(guardado.estado)) {
    await quitarDeCola(guardado.cafeteriaId, guardado._id);
  }
  await notificar(guardado.usuarioId, {
    pedidoId: guardado._id,
    estado: guardado.estado,
    mensaje: mensajeDeEstado(guardado)
  });
  // El reporte de mas vendidos cuenta pedidos ENTREGADO: puede cambiar
  await invalidarCache(clavesCache.productosMasVendidos(guardado.cafeteriaId));
  return guardado;
}

// Productos (con su tiempo de preparacion) de una lista de items de ESTA cafeteria
async function tiemposDeItems(cafeteriaId, items) {
  const ids = items.map(item => item.productoId);
  ids.forEach(id => validarId(id, "producto"));
  const productos = await ProductoModel.find({ _id: { $in: ids }, cafeteriaId })
    .select("tiempoPreparacionMin");
  const tiempos = new Map(productos.map(p => [String(p._id), p.tiempoPreparacionMin ?? 5]));
  return items.map(item => {
    if (!tiempos.has(String(item.productoId))) {
      throw datoInvalido(`El producto ${item.productoId} no es de esta cafeteria.`);
    }
    return { tiempoPreparacionMin: tiempos.get(String(item.productoId)), cantidad: item.cantidad };
  });
}

// -------------------------------------------------
// Helpers
// -------------------------------------------------
// Lee una moneda del catalogo y la convierte en objeto de dominio.
async function obtenerMonedaDominio(codigo) {
  const doc = await MonedaModel.findOne({ codigo: normalizarClave(codigo) });
  if (!doc) {
    throw new Error(`La moneda "${codigo}" no existe en el catalogo de monedas.`);
  }
  if (!doc.activa) {
    throw new Error(`La moneda "${doc.codigo}" esta inactiva.`);
  }
  return new Moneda(doc.codigo, doc.simbolo, doc.decimales);
}

// Lee un estado del catalogo y lo convierte en objeto de dominio.
async function obtenerEstadoDominio(clave) {
  const doc = await EstadoPedidoModel.findOne({ clave: normalizarClave(clave) });
  if (!doc) {
    throw new Error(`El estado "${clave}" no existe en el catalogo de estados de pedido.`);
  }
  return new EstadoPedido(doc.clave, doc.nombre, doc.transiciones, doc.esFinal);
}

// Borra del cache todo lo que depende del inventario de una cafeteria.
async function invalidarProductos(cafeteriaId, productoIds = []) {
  await invalidarCache(
    clavesCache.productosPorCafeteria(cafeteriaId),
    clavesCache.productosPorReponer(cafeteriaId),
    ...productoIds.map(id => clavesCache.producto(id))
  );
}

// Un pedido lo puede ver quien lo hizo o quien gestiona su cafeteria.
async function validarAccesoPedido(contexto, pedido) {
  const { usuarioId } = requerirSesion(contexto);
  if (String(pedido.usuarioId) === String(usuarioId)) return;
  if (await puede(usuarioId, "PEDIDO_LEER_CAFETERIA", { cafeteriaId: pedido.cafeteriaId })) return;
  throw prohibido("No puedes ver este pedido.");
}

// Pipeline de agregacion: productos mas vendidos DENTRO de una cafeteria
// especifica. El $match filtra desde el inicio para no mezclar datos
// de distintas escuelas/cafeterias entre si (multi-tenant).
async function calcularProductosMasVendidos(cafeteriaId) {
  const resultado = await PedidoModel.aggregate([
    // Etapa 1: solo pedidos completados de ESTA cafeteria
    {
      $match: {
        cafeteriaId: new mongoose.Types.ObjectId(cafeteriaId),
        estado: ESTADO_VENTA_COMPLETADA
      }
    },
    // Etapa 2: aplanar el arreglo de items incrustado
    { $unwind: "$items" },
    // Etapa 3: agrupar por producto y moneda (nunca se suman monedas distintas)
    {
      $group: {
        _id: {
          nombreProducto: "$items.nombreProducto",
          moneda: "$items.precioUnitario.moneda"
        },
        unidadesVendidas: { $sum: "$items.cantidad" },
        ingresosTotales: {
          $sum: { $multiply: ["$items.cantidad", "$items.precioUnitario.monto"] }
        }
      }
    },
    // Etapa 4: ordenar del mas vendido al menos vendido
    { $sort: { unidadesVendidas: -1 } }
  ]);

  // Se redondean los ingresos segun los decimales de cada moneda.
  const catalogo = await MonedaModel.find({});
  const monedas = new Map(
    catalogo.map(m => [m.codigo, new Moneda(m.codigo, m.simbolo, m.decimales)])
  );

  return resultado.map(item => {
    const moneda = monedas.get(item._id.moneda);
    return {
      nombreProducto: item._id.nombreProducto,
      unidadesVendidas: item.unidadesVendidas,
      ingresosTotales: {
        monto: moneda ? moneda.redondear(item.ingresosTotales) : item.ingresosTotales,
        moneda: item._id.moneda
      }
    };
  });
}

export const resolvers = {
  Escuela: resolversMultiempresa.Escuela,
  Negocio: resolversMultiempresa.Negocio,
  Usuario: resolversMultiempresa.Usuario,

  Pedido: {
    // El codigo solo lo ve quien hizo el pedido; el vendedor se lo pide al recoger
    codigoRecogida: (pedido, _, contexto) =>
      contexto.auth && String(contexto.auth.usuarioId) === String(pedido.usuarioId)
        ? pedido.codigoRecogida
        : null,
    posicionEnCola: pedido => posicionEnCola(pedido.cafeteriaId, pedido.id)
  },

  // Cada producto puede mostrar su cafeteria (util en dondeHay)
  Producto: {
    cafeteria: async producto => {
      const doc = await CafeteriaModel.findById(producto.cafeteriaId);
      return doc ? mapCafeteria(doc) : null;
    }
  },

  // Un Cafeteria expone su escuela completa, no solo el id.
  Cafeteria: {
    ...resolversMultiempresa.Cafeteria,
    escuela: async cafeteria => {
      const doc = await EscuelaModel.findById(cafeteria.escuelaId);
      if (!doc) {
        throw new Error("La cafeteria apunta a una escuela que no existe.");
      }
      return mapEscuela(doc);
    }
  },

  Query: {
    ...resolversMultiempresa.Query,

    // ---- Sesion ----
    terminos: () =>
      readFileSync(path.join(__dirname, "../contenido/terminos.md"), "utf8"),
    me: async (_, __, contexto) => {
      const { usuarioId } = requerirSesion(contexto);
      const doc = await UsuarioModel.findById(usuarioId);
      if (!doc) {
        throw noAutorizado("El usuario de la sesion ya no existe.");
      }
      return mapUsuario(doc);
    },

    // ---- Catalogos (cache-aside) ----
    monedas: () =>
      obtenerConCache(clavesCache.monedas(), async () => {
        const docs = await MonedaModel.find({}).sort({ codigo: 1 });
        return docs.map(mapMoneda);
      }),

    estadosPedido: () =>
      obtenerConCache(clavesCache.estadosPedido(), async () => {
        const docs = await EstadoPedidoModel.find({}).sort({ orden: 1 });
        return docs.map(mapEstadoPedido);
      }),

    // Catalogo publico: solo escuelas activas (ver tambien catalogoEscuelas)
    escuelas: async () => {
      const docs = await EscuelaModel.find({ activa: true }).sort({ nombre: 1 });
      return docs.map(mapEscuela);
    },

    escuela: async (_, { id }) => {
      const doc = await EscuelaModel.findById(id);
      return doc ? mapEscuela(doc) : null;
    },

    escuelaPorClave: async (_, { clave }) => {
      const doc = await EscuelaModel.findOne({ clave: normalizarClave(clave) });
      return doc ? mapEscuela(doc) : null;
    },

    cafeterias: async () => {
      const docs = await CafeteriaModel.find({ activa: true }).sort({ nombre: 1 });
      return docs.map(mapCafeteria);
    },

    cafeteria: async (_, { id }) => {
      const doc = await CafeteriaModel.findById(id);
      return doc ? mapCafeteria(doc) : null;
    },

    cafeteriasPorEscuela: async (_, { escuelaId }) => {
      validarId(escuelaId, "escuela");
      const docs = await CafeteriaModel.find({ escuelaId, activa: true }).sort({ nombre: 1 });
      return docs.map(mapCafeteria);
    },

    // ---- Productos e inventario (cache-aside) ----
    // Menu agrupado por categoria, como lo muestra la app. Usa el mismo cache
    // que productosPorCafeteria.
    menuPorCategoria: async (_, { cafeteriaId }) => {
      validarId(cafeteriaId, "cafeteria");
      const productos = await obtenerConCache(clavesCache.productosPorCafeteria(cafeteriaId), async () => {
        const docs = await ProductoModel.find({ cafeteriaId });
        return docs.map(mapProducto);
      });
      const categorias = new Map();
      for (const producto of productos) {
        if (!categorias.has(producto.categoria)) categorias.set(producto.categoria, []);
        categorias.get(producto.categoria).push(producto);
      }
      return [...categorias.entries()]
        .map(([categoria, lista]) => ({
          categoria,
          productos: lista.sort((a, b) => Number(b.destacado) - Number(a.destacado) || a.nombre.localeCompare(b.nombre))
        }))
        .sort((a, b) => a.categoria.localeCompare(b.categoria));
    },

    // Si un platillo se acabo, en que otras cafeterias del MISMO negocio y la
    // MISMA escuela todavia hay (ej. "no hay molletes aqui, pero si en la Cafeteria A")
    dondeHay: async (_, { productoId }) => {
      validarId(productoId, "producto");
      const producto = await ProductoModel.findById(productoId);
      if (!producto) return [];
      const cafeteria = await CafeteriaModel.findById(producto.cafeteriaId);
      if (!cafeteria) return [];

      const hermanas = await CafeteriaModel.find({
        _id: { $ne: cafeteria._id },
        negocioId: cafeteria.negocioId,
        escuelaId: cafeteria.escuelaId,
        activa: true
      }).select("_id");
      const nombre = new RegExp(`^${producto.nombre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
      const docs = await ProductoModel.find({
        cafeteriaId: { $in: hermanas.map(c => c._id) },
        nombre,
        disponible: true,
        "inventario.stock": { $gt: 0 }
      });
      return docs.map(mapProducto);
    },

    productosPorCafeteria: (_, { cafeteriaId }) =>
      obtenerConCache(clavesCache.productosPorCafeteria(cafeteriaId), async () => {
        const docs = await ProductoModel.find({ cafeteriaId });
        return docs.map(mapProducto);
      }),

    producto: (_, { id }) =>
      obtenerConCache(clavesCache.producto(id), async () => {
        const doc = await ProductoModel.findById(id);
        return doc ? mapProducto(doc) : null;
      }),

    // Productos que ya llegaron a su punto de reorden (stock <= puntoReorden).
    productosPorReponer: async (_, { cafeteriaId }, contexto) => {
      await autorizar(contexto, "INVENTARIO_REPONER", { cafeteriaId });
      return obtenerConCache(clavesCache.productosPorReponer(cafeteriaId), async () => {
        const docs = await ProductoModel.find({
          cafeteriaId,
          $expr: { $lte: ["$inventario.stock", "$inventario.puntoReorden"] }
        });
        return docs.map(mapProducto);
      });
    },

    // ---- Pedidos ----
    pedido: async (_, { id }, contexto) => {
      validarId(id, "pedido");
      const doc = await PedidoModel.findById(id);
      if (!doc) return null;
      await validarAccesoPedido(contexto, doc);
      return mapPedido(doc);
    },

    // Los pedidos del usuario que inicio sesion
    misPedidos: async (_, __, contexto) => {
      const { usuarioId } = await autorizar(contexto, "PEDIDO_LEER_PROPIOS");
      const docs = await PedidoModel.find({ usuarioId }).sort({ createdAt: -1 });
      return docs.map(mapPedido);
    },

    // Se mantiene por compatibilidad con la app: solo devuelve los pedidos propios
    pedidosPorUsuario: async (_, { usuarioId }, contexto) => {
      const auth = await autorizar(contexto, "PEDIDO_LEER_PROPIOS");
      if (String(auth.usuarioId) !== String(usuarioId)) {
        throw prohibido("Solo puedes ver tus propios pedidos.");
      }
      const docs = await PedidoModel.find({ usuarioId }).sort({ createdAt: -1 });
      return docs.map(mapPedido);
    },

    // Pantalla del vendedor: pedidos activos ordenados por hora de recogida
    colaCafeteria: async (_, { cafeteriaId }, contexto) => {
      validarId(cafeteriaId, "cafeteria");
      await autorizar(contexto, "PEDIDO_LEER_CAFETERIA", { cafeteriaId });
      const docs = await PedidoModel.find({
        cafeteriaId,
        estado: { $in: ["PENDIENTE", "ACEPTADO", "EN_PREPARACION", "LISTO"] }
      }).sort({ horaRecogida: 1, createdAt: 1 });
      return docs.map(mapPedido);
    },

    // Antes de pedir: "si pides ahora, recoges a las 10:25"
    estimarRecogida: async (_, { cafeteriaId, items }) => {
      validarId(cafeteriaId, "cafeteria");
      if (!items.length) {
        throw datoInvalido("Agrega al menos un producto para estimar el tiempo.");
      }
      const tiempos = await tiemposDeItems(cafeteriaId, items);
      const cola = await estadoCola(cafeteriaId);
      const { totalMin } = calcularTiempoEstimado(tiempos, cola.minutos, CAPACIDAD_PARALELA);
      return {
        tiempoEstimadoMin: totalMin,
        horaRecogida: new Date(Date.now() + totalMin * 60 * 1000).toISOString(),
        pedidosEnCola: cola.pedidos
      };
    },

    misNotificaciones: async (_, { limite }, contexto) => {
      const { usuarioId } = requerirSesion(contexto);
      return leerNotificaciones(usuarioId, Math.min(Math.max(limite ?? 20, 1), 50));
    },

    pedidosPorCafeteria: async (_, { cafeteriaId }, contexto) => {
      await autorizar(contexto, "PEDIDO_LEER_CAFETERIA", { cafeteriaId });
      const docs = await PedidoModel.find({ cafeteriaId }).sort({ createdAt: -1 });
      return docs.map(mapPedido);
    },

    // Reporte analitico (pipeline de agregacion), tambien con cache-aside
    productosMasVendidos: async (_, { cafeteriaId }, contexto) => {
      await autorizar(contexto, "REPORTE_VENTAS_LEER", { cafeteriaId });
      return obtenerConCache(clavesCache.productosMasVendidos(cafeteriaId), () =>
        calcularProductosMasVendidos(cafeteriaId)
      );
    }
  },

  Mutation: {
    ...resolversMultiempresa.Mutation,

    // ---- Sesion ----
    login: async (_, { correo, password }) => {
      // Se aplica la misma normalizacion usada al registrar la cuenta.
      const correoNormalizado = correo.trim().toLowerCase();
      const doc = await UsuarioModel.findOne({ correo: correoNormalizado })
        .select("+passwordHash");
      // No revela si fallo el correo o la contrasena; compara contra el hash guardado.
      const valido = doc?.passwordHash && (await bcrypt.compare(password, doc.passwordHash));
      if (!valido) {
        throw noAutorizado("Correo o contrasena incorrectos.");
      }
      const { token, expiraEn } = await iniciarSesion(doc);
      return { token, expiraEn, usuario: mapUsuario(doc) };
    },

    // Registro publico de compradores (rol CLIENTE). El comprador elige su
    // escuela del catalogo; por compatibilidad con la app tambien se acepta
    // una cafeteria, y se toma la escuela de esa cafeteria.
    registro: async (_, { nombre, correo, password, escuelaId, cafeteriaId }) => {
      let escuelaElegida = escuelaId;
      if (!escuelaElegida && cafeteriaId) {
        validarId(cafeteriaId, "cafeteria");
        const cafeteria = await CafeteriaModel.findById(cafeteriaId);
        if (!cafeteria || !cafeteria.activa) {
          throw datoInvalido("La cafeteria indicada no existe o esta inactiva.");
        }
        escuelaElegida = cafeteria.escuelaId;
      }
      if (!escuelaElegida) {
        throw datoInvalido("Debes elegir tu escuela.");
      }
      validarId(escuelaElegida, "escuela");
      const escuela = await EscuelaModel.findById(escuelaElegida);
      if (!escuela || !escuela.activa) {
        throw datoInvalido("La escuela indicada no existe o esta suspendida.");
      }

      const doc = await crearCuenta(
        { nombre, correo, password },
        { rol: ROLES.CLIENTE, escuelaId: escuela._id }
      );
      await sincronizarSinFallar(`el comprador ${doc.correo}`, () => sincronizarUsuario(doc));
      const { token, expiraEn } = await iniciarSesion(doc);
      return { token, expiraEn, usuario: mapUsuario(doc) };
    },

    logout: async (_, __, contexto) => {
      const { jti } = requerirSesion(contexto);
      return cerrarSesion(jti);
    },

    // ---- Catalogos ----
    registrarMoneda: async (_, { codigo, nombre, simbolo, decimales }, contexto) => {
      await autorizar(contexto, "PLATAFORMA_ADMINISTRAR");
      try {
        const doc = await new MonedaModel({ codigo, nombre, simbolo, decimales }).save();
        await invalidarCache(clavesCache.monedas());
        return mapMoneda(doc);
      } catch (error) {
        return manejarDuplicado(error, `Ya existe la moneda "${normalizarClave(codigo)}".`);
      }
    },

    // ---- Productos e inventario ----
    registrarProducto: async (_, {
      nombre, precio, disponible, inventario, cafeteriaId,
      descripcion, categoria, imagenUrl, destacado, etiqueta, tiempoPreparacionMin
    }, contexto) => {
      validarId(cafeteriaId, "cafeteria");
      // Solo quien vende en esa cafeteria (o su jefe) puede agregar al menu
      await autorizar(contexto, "PRODUCTO_GESTIONAR", { cafeteriaId });
      const cafeteria = await CafeteriaModel.findById(cafeteriaId);
      if (!cafeteria) {
        throw new Error("La cafeteria indicada no existe.");
      }

      // El precio debe estar en una moneda del catalogo y respetar sus decimales
      const precioFinal = await precioValidado(precio);

      // Validaciones de dominio antes de persistir
      const productoDominio = new Producto(
        null,
        nombre,
        precioFinal,
        disponible ?? true,
        new Inventario(inventario.stock, inventario.puntoReorden, inventario.cantidadReposicion),
        tiempoPreparacionMin ?? 5
      );
      productoDominio.validarNombre();
      productoDominio.validarPrecioPositivo();
      productoDominio.validarInventario();
      productoDominio.validarTiempoPreparacion();

      const doc = await new ProductoModel({
        nombre,
        precio: productoDominio.precio,
        disponible: productoDominio.disponible,
        inventario: {
          stock: inventario.stock,
          puntoReorden: inventario.puntoReorden,
          cantidadReposicion: inventario.cantidadReposicion
        },
        descripcion,
        categoria,
        imagenUrl,
        destacado,
        etiqueta,
        tiempoPreparacionMin: productoDominio.tiempoPreparacionMin,
        cafeteriaId
      }).save().catch(error => { throw validacionMongoose(error); });

      await invalidarProductos(cafeteriaId);
      return mapProducto(doc);
    },

    // El vendedor edita un platillo de su menu. Solo cambia los campos enviados.
    actualizarProducto: async (_, { productoId, cambios }, contexto) => {
      validarId(productoId, "producto");
      const producto = await ProductoModel.findById(productoId);
      if (!producto) {
        throw datoInvalido("El producto no existe.");
      }
      await autorizar(contexto, "PRODUCTO_GESTIONAR", { cafeteriaId: producto.cafeteriaId });

      const campos = ["nombre", "descripcion", "categoria", "imagenUrl", "destacado",
        "etiqueta", "disponible", "tiempoPreparacionMin"];
      for (const campo of campos) {
        if (cambios[campo] !== undefined && cambios[campo] !== null) {
          producto[campo] = cambios[campo];
        }
      }
      if (cambios.precio) {
        producto.precio = await precioValidado(cambios.precio);
      }

      // Las mismas reglas de dominio que al registrar
      const dominio = new Producto(
        producto._id,
        producto.nombre,
        producto.precio,
        producto.disponible,
        new Inventario(
          producto.inventario.stock,
          producto.inventario.puntoReorden,
          producto.inventario.cantidadReposicion
        ),
        producto.tiempoPreparacionMin
      );
      dominio.validarNombre();
      dominio.validarPrecioPositivo();
      dominio.validarTiempoPreparacion();

      const guardado = await producto.save().catch(error => { throw validacionMongoose(error); });
      await invalidarProductos(guardado.cafeteriaId, [productoId]);
      return mapProducto(guardado);
    },

    // Atajo para "se acabo" / "ya hay": pausa o reactiva un platillo sin borrarlo
    cambiarDisponibilidadProducto: async (_, { productoId, disponible }, contexto) => {
      validarId(productoId, "producto");
      const producto = await ProductoModel.findById(productoId);
      if (!producto) {
        throw datoInvalido("El producto no existe.");
      }
      await autorizar(contexto, "PRODUCTO_GESTIONAR", { cafeteriaId: producto.cafeteriaId });
      producto.disponible = disponible;
      const guardado = await producto.save();
      await invalidarProductos(guardado.cafeteriaId, [productoId]);
      return mapProducto(guardado);
    },

    // Restock: suma unidades al stock. Sin cantidad, usa la cantidad de
    // reposicion configurada en el producto.
    reponerInventario: async (_, { productoId, cantidad }, contexto) => {
      validarId(productoId, "producto");
      const producto = await ProductoModel.findById(productoId);
      if (!producto) {
        throw new Error("El producto no existe.");
      }
      await autorizar(contexto, "INVENTARIO_REPONER", { cafeteriaId: producto.cafeteriaId });

      const unidades = cantidad ?? producto.inventario.cantidadReposicion;
      if (unidades <= 0) {
        throw new Error("La cantidad a reponer debe ser mayor a 0.");
      }

      // $inc es atomico: dos reposiciones al mismo tiempo no se pisan.
      const actualizado = await ProductoModel.findByIdAndUpdate(
        productoId,
        { $inc: { "inventario.stock": unidades } },
        { new: true }
      );
      await invalidarProductos(actualizado.cafeteriaId, [productoId]);
      return mapProducto(actualizado);
    },

    // ---- Pedidos ----
    // El pedido siempre es del usuario de la sesion. Regla multi-tenant: solo
    // se puede pedir en cafeterias de la escuela a la que pertenece el usuario.
    crearPedido: async (_, { usuarioId: usuarioIdEnviado, cafeteriaId, items, horaRecogida, notas }, contexto) => {
      validarId(cafeteriaId, "cafeteria");
      const { usuarioId } = await autorizar(contexto, "PEDIDO_CREAR", { cafeteriaId });
      if (usuarioIdEnviado && String(usuarioIdEnviado) !== String(usuarioId)) {
        throw prohibido("No puedes hacer pedidos a nombre de otro usuario.");
      }
      const cafeteria = await CafeteriaModel.findById(cafeteriaId);
      if (!cafeteria?.activa) {
        throw datoInvalido("La cafeteria no existe o esta cerrada.");
      }

      // Todo pedido nuevo nace en el estado marcado como inicial en el catalogo
      const estadoInicial = await EstadoPedidoModel.findOne({ esInicial: true });
      if (!estadoInicial) {
        throw new Error("No hay un estado inicial en el catalogo de estados. Ejecuta `npm run seed`.");
      }

      // Si el mismo producto viene dos veces, se suman las cantidades
      const cantidades = new Map();
      for (const { productoId, cantidad } of items) {
        if (cantidad <= 0) {
          throw new Error("La cantidad de cada producto debe ser mayor a 0.");
        }
        const clave = String(productoId);
        cantidades.set(clave, (cantidades.get(clave) ?? 0) + cantidad);
      }

      // Cuanto trabajo tiene ya la cocina (cola en Redis)
      const cola = await estadoCola(cafeteriaId);

      // Crear el pedido y descontar el stock es UNA sola operacion: si algo
      // falla (sin stock, monedas mezcladas...), la transaccion se revierte y
      // el inventario queda como estaba. Requiere replica set (Atlas lo es).
      const session = await mongoose.startSession();
      let pedidoGuardado;
      let estimacion;

      try {
        await session.withTransaction(async () => {
          const itemsPedido = [];
          const tiemposItems = [];

          for (const [productoId, cantidad] of cantidades) {
            const producto = await ProductoModel.findById(productoId).session(session);
            if (!producto) {
              throw new Error(`El producto ${productoId} no existe.`);
            }
            // Regla multi-tenant: no se pueden mezclar productos de otra cafeteria
            if (String(producto.cafeteriaId) !== String(cafeteriaId)) {
              throw new Error(`El producto "${producto.nombre}" no pertenece a esta cafeteria.`);
            }
            if (!producto.disponible) {
              throw new Error(`El producto "${producto.nombre}" no está disponible.`);
            }

            // Descuento atomico: solo se descuenta si alcanza el stock.
            const actualizado = await ProductoModel.findOneAndUpdate(
              { _id: producto._id, "inventario.stock": { $gte: cantidad } },
              { $inc: { "inventario.stock": -cantidad } },
              { new: true, session }
            );
            if (!actualizado) {
              throw new Error(
                `No hay stock suficiente de "${producto.nombre}" ` +
                `(disponible: ${producto.inventario.stock}, pedido: ${cantidad}).`
              );
            }

            const item = new ItemPedido(
              producto._id,
              producto.nombre,
              { monto: producto.precio.monto, moneda: producto.precio.moneda },
              cantidad
            );
            item.validarCantidad();
            itemsPedido.push(item);
            tiemposItems.push({ tiempoPreparacionMin: producto.tiempoPreparacionMin ?? 5, cantidad });
          }

          // Reglas de dominio: el pedido no puede ir vacio, se cobra en una sola
          // moneda y el total se calcula aqui, nunca viene del cliente.
          const pedidoDominio = new Pedido(null, usuarioId, itemsPedido, estadoInicial.clave);
          pedidoDominio.validarTieneItems();
          const moneda = await obtenerMonedaDominio(pedidoDominio.validarUnaSolaMoneda());
          const total = pedidoDominio.calcularTotal(moneda);

          // Pickup: cuanto tarda y a que hora se recoge
          estimacion = calcularTiempoEstimado(tiemposItems, cola.minutos, CAPACIDAD_PARALELA);
          const ahora = new Date();
          const masTemprana = new Date(ahora.getTime() + estimacion.totalMin * 60 * 1000);
          let recogida = masTemprana;
          if (horaRecogida) {
            recogida = new Date(horaRecogida);
            try {
              validarHoraRecogida(recogida, masTemprana, ahora);
            } catch (error) {
              throw datoInvalido(error.message);
            }
          }

          const [doc] = await PedidoModel.create(
            [
              {
                usuarioId,
                cafeteriaId,
                items: itemsPedido.map(i => ({
                  productoId: i.productoId,
                  nombreProducto: i.nombreProducto,
                  precioUnitario: { monto: i.precioUnitario.monto, moneda: i.precioUnitario.moneda },
                  cantidad: i.cantidad
                })),
                total,
                estado: estadoInicial.clave,
                escuelaId: cafeteria.escuelaId,
                negocioId: cafeteria.negocioId,
                historial: [{ estado: estadoInicial.clave, fecha: ahora, usuarioId }],
                tiempoEstimadoMin: Math.round((recogida - ahora) / 60000),
                horaRecogida: recogida,
                codigoRecogida: String(randomInt(0, 10000)).padStart(4, "0"),
                notas: notas ?? ""
              }
            ],
            { session }
          );
          pedidoGuardado = doc;
        });
      } catch (error) {
        if (/replica set|Transaction numbers/i.test(error.message)) {
          throw new Error(
            "Este MongoDB no soporta transacciones (requiere replica set, como MongoDB Atlas)."
          );
        }
        throw error;
      } finally {
        await session.endSession();
      }

      // El pedido desconto stock: lo cacheado de esos productos ya no es valido
      await invalidarProductos(cafeteriaId, [...cantidades.keys()]);
      // Entra a la cola de cocina con los minutos que le toma prepararse
      await agregarACola(cafeteriaId, pedidoGuardado._id, estimacion.preparacionMin);
      return mapPedido(pedidoGuardado);
    },

    // El comprador cancela su pedido mientras la cafeteria aun no lo acepta
    cancelarPedido: async (_, { pedidoId }, contexto) => {
      validarId(pedidoId, "pedido");
      const pedido = await PedidoModel.findById(pedidoId);
      if (!pedido) {
        throw datoInvalido("El pedido no existe.");
      }
      const { usuarioId } = await autorizar(contexto, "PEDIDO_CANCELAR_PROPIO", {
        cafeteriaId: pedido.cafeteriaId
      });
      if (String(pedido.usuarioId) !== String(usuarioId)) {
        throw prohibido("Solo puedes cancelar tus propios pedidos.");
      }
      if (pedido.estado !== "PENDIENTE") {
        throw datoInvalido("Ya no puedes cancelarlo: la cafeteria ya acepto tu pedido.");
      }
      return mapPedido(await cambiarEstado(pedido, "CANCELADO", usuarioId));
    },

    // El vendedor avanza el pedido. Las transiciones validas salen del catalogo
    // de estados. Para ENTREGADO hay que dar el codigo que muestra el comprador.
    actualizarEstadoPedido: async (_, { pedidoId, nuevoEstado, codigoRecogida }, contexto) => {
      validarId(pedidoId, "pedido");
      const doc = await PedidoModel.findById(pedidoId);
      if (!doc) {
        throw new Error("El pedido no existe.");
      }
      const { usuarioId } = await autorizar(contexto, "PEDIDO_CAMBIAR_ESTADO", {
        cafeteriaId: doc.cafeteriaId
      });

      const clave = normalizarClave(nuevoEstado);
      if (clave === "ENTREGADO" && doc.codigoRecogida && codigoRecogida !== doc.codigoRecogida) {
        throw datoInvalido("El codigo de recogida no coincide. Pideselo al comprador.");
      }
      return mapPedido(await cambiarEstado(doc, clave, usuarioId));
    }
  }
};