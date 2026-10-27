import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { GraphQLError } from "graphql";
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
  Pedido
} from "../domain/entities.js";
import { obtenerConCache, invalidarCache, clavesCache } from "../infrastructure/cache.js";
import {
  iniciarSesion,
  cerrarSesion,
  requerirSesion,
  noAutorizado
} from "../infrastructure/auth.js";

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

function mapEscuela(doc) {
  return { id: doc._id, clave: doc.clave, nombre: doc.nombre, activa: doc.activa };
}

function mapCafeteria(doc) {
  return { id: doc._id, nombre: doc.nombre, escuelaId: doc.escuelaId, activa: doc.activa };
}

function mapUsuario(doc) {
  return { id: doc._id, nombre: doc.nombre, correo: doc.correo, cafeteriaId: doc.cafeteriaId };
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
    cafeteriaId: doc.cafeteriaId
  };
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
    estado: doc.estado
  };
}

// -------------------------------------------------
// Helpers
// -------------------------------------------------
const normalizarClave = valor => String(valor).trim().toUpperCase();

function entradaInvalida(mensaje) {
  return new GraphQLError(mensaje, {
    extensions: { code: "BAD_USER_INPUT" }
  });
}

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

// Convierte el error crudo de "llave duplicada" de Mongo en un mensaje claro.
function manejarDuplicado(error, mensaje) {
  if (error?.code === 11000) {
    throw new Error(mensaje);
  }
  throw error;
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
  // Un Cafeteria expone su escuela completa, no solo el id.
  Cafeteria: {
    escuela: async cafeteria => {
      const doc = await EscuelaModel.findById(cafeteria.escuelaId);
      if (!doc) {
        throw new Error("La cafeteria apunta a una escuela que no existe.");
      }
      return mapEscuela(doc);
    }
  },

  Query: {
    // ---- Sesion ----
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

    escuelas: async () => {
      const docs = await EscuelaModel.find({}).sort({ nombre: 1 });
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
      const docs = await CafeteriaModel.find({});
      return docs.map(mapCafeteria);
    },

    cafeteria: async (_, { id }) => {
      const doc = await CafeteriaModel.findById(id);
      return doc ? mapCafeteria(doc) : null;
    },

    cafeteriasPorEscuela: async (_, { escuelaId }) => {
      const docs = await CafeteriaModel.find({ escuelaId });
      return docs.map(mapCafeteria);
    },

    // ---- Productos e inventario (cache-aside) ----
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
    productosPorReponer: (_, { cafeteriaId }) =>
      obtenerConCache(clavesCache.productosPorReponer(cafeteriaId), async () => {
        const docs = await ProductoModel.find({
          cafeteriaId,
          $expr: { $lte: ["$inventario.stock", "$inventario.puntoReorden"] }
        });
        return docs.map(mapProducto);
      }),

    // ---- Pedidos ----
    pedido: async (_, { id }) => {
      const doc = await PedidoModel.findById(id);
      return doc ? mapPedido(doc) : null;
    },

    pedidosPorUsuario: async (_, { usuarioId }) => {
      const docs = await PedidoModel.find({ usuarioId });
      return docs.map(mapPedido);
    },

    pedidosPorCafeteria: async (_, { cafeteriaId }) => {
      const docs = await PedidoModel.find({ cafeteriaId });
      return docs.map(mapPedido);
    },

    // Reporte analitico (pipeline de agregacion), tambien con cache-aside
    productosMasVendidos: (_, { cafeteriaId }) =>
      obtenerConCache(clavesCache.productosMasVendidos(cafeteriaId), () =>
        calcularProductosMasVendidos(cafeteriaId)
      )
  },

  Mutation: {
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
      const { token, expiraEn } = await iniciarSesion(doc._id);
      return { token, expiraEn, usuario: mapUsuario(doc) };
    },

    logout: async (_, __, contexto) => {
      const { jti } = requerirSesion(contexto);
      return cerrarSesion(jti);
    },

    // ---- Catalogos ----
    registrarMoneda: async (_, { codigo, nombre, simbolo, decimales }) => {
      try {
        const doc = await new MonedaModel({ codigo, nombre, simbolo, decimales }).save();
        await invalidarCache(clavesCache.monedas());
        return mapMoneda(doc);
      } catch (error) {
        return manejarDuplicado(error, `Ya existe la moneda "${normalizarClave(codigo)}".`);
      }
    },

    registrarEscuela: async (_, { clave, nombre }) => {
      try {
        const doc = await new EscuelaModel({ clave, nombre }).save();
        return mapEscuela(doc);
      } catch (error) {
        return manejarDuplicado(error, `Ya existe una escuela con la clave "${normalizarClave(clave)}".`);
      }
    },

    registrarCafeteria: async (_, { nombre, escuelaId }) => {
      const escuela = await EscuelaModel.findById(escuelaId);
      if (!escuela) {
        throw new Error("La escuela indicada no existe.");
      }
      if (!escuela.activa) {
        throw new Error("La escuela indicada esta inactiva.");
      }

      try {
        const doc = await new CafeteriaModel({ nombre, escuelaId }).save();
        return mapCafeteria(doc);
      } catch (error) {
        return manejarDuplicado(error, `La escuela "${escuela.clave}" ya tiene una cafeteria llamada "${nombre}".`);
      }
    },

    registrarUsuario: async (_, { nombre, correo, password, cafeteriaId }) => {
      // Canonicalizar el correo antes de validar y guardar evita cuentas duplicadas por mayusculas.
      const nombreNormalizado = nombre.trim();
      const correoNormalizado = correo.trim().toLowerCase();

      if (!nombreNormalizado) {
        throw entradaInvalida("El nombre no puede estar vacio.");
      }
      if (
        correoNormalizado.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correoNormalizado)
      ) {
        throw entradaInvalida("Debes proporcionar un correo electronico valido.");
      }
      // Mantener la regla minima antes de generar el hash bcrypt.
      if (password.length < 6) {
        throw entradaInvalida("La contrasena debe tener al menos 6 caracteres.");
      }
      if (!mongoose.isValidObjectId(cafeteriaId)) {
        throw entradaInvalida("El identificador de cafeteria no es valido.");
      }

      const cafeteria = await CafeteriaModel.findById(cafeteriaId);
      if (!cafeteria) {
        throw entradaInvalida("La cafeteria indicada no existe.");
      }
      if (!cafeteria.activa) {
        throw entradaInvalida("La cafeteria indicada esta inactiva.");
      }

      try {
        // Nunca persistir la contrasena en texto claro.
        const passwordHash = await bcrypt.hash(password, 10);
        const doc = await new UsuarioModel({
          nombre: nombreNormalizado,
          correo: correoNormalizado,
          passwordHash,
          cafeteriaId
        }).save();
        return mapUsuario(doc);
      } catch (error) {
        return manejarDuplicado(error, `Ya existe un usuario con el correo "${correoNormalizado}".`);
      }
    },

    // ---- Productos e inventario ----
    registrarProducto: async (_, { nombre, precio, disponible, inventario, cafeteriaId }) => {
      const cafeteria = await CafeteriaModel.findById(cafeteriaId);
      if (!cafeteria) {
        throw new Error("La cafeteria indicada no existe.");
      }

      // El precio debe estar en una moneda del catalogo y respetar sus decimales
      const moneda = await obtenerMonedaDominio(precio.moneda);
      moneda.validarMonto(precio.monto);

      // Validaciones de dominio antes de persistir
      const productoDominio = new Producto(
        null,
        nombre,
        { monto: precio.monto, moneda: moneda.codigo },
        disponible ?? true,
        new Inventario(inventario.stock, inventario.puntoReorden, inventario.cantidadReposicion)
      );
      productoDominio.validarPrecioPositivo();
      productoDominio.validarInventario();

      const doc = await new ProductoModel({
        nombre,
        precio: productoDominio.precio,
        disponible: productoDominio.disponible,
        inventario: {
          stock: inventario.stock,
          puntoReorden: inventario.puntoReorden,
          cantidadReposicion: inventario.cantidadReposicion
        },
        cafeteriaId
      }).save();

      await invalidarProductos(cafeteriaId);
      return mapProducto(doc);
    },

    // Restock: suma unidades al stock. Sin cantidad, usa la cantidad de
    // reposicion configurada en el producto.
    reponerInventario: async (_, { productoId, cantidad }) => {
      const producto = await ProductoModel.findById(productoId);
      if (!producto) {
        throw new Error("El producto no existe.");
      }

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
    crearPedido: async (_, { usuarioId, cafeteriaId, items }) => {
      const usuario = await UsuarioModel.findById(usuarioId);
      if (!usuario) {
        throw new Error("El usuario no existe.");
      }
      // Regla multi-tenant: el usuario debe pertenecer a la cafeteria del pedido
      if (String(usuario.cafeteriaId) !== String(cafeteriaId)) {
        throw new Error("El usuario no pertenece a esta cafeteria.");
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

      // Crear el pedido y descontar el stock es UNA sola operacion: si algo
      // falla (sin stock, monedas mezcladas...), la transaccion se revierte y
      // el inventario queda como estaba. Requiere replica set (Atlas lo es).
      const session = await mongoose.startSession();
      let pedidoGuardado;

      try {
        await session.withTransaction(async () => {
          const itemsPedido = [];

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
          }

          // Reglas de dominio: el pedido no puede ir vacio, se cobra en una sola
          // moneda y el total se calcula aqui, nunca viene del cliente.
          const pedidoDominio = new Pedido(null, usuarioId, itemsPedido, estadoInicial.clave);
          pedidoDominio.validarTieneItems();
          const moneda = await obtenerMonedaDominio(pedidoDominio.validarUnaSolaMoneda());
          const total = pedidoDominio.calcularTotal(moneda);

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
                estado: estadoInicial.clave
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
      return mapPedido(pedidoGuardado);
    },

    actualizarEstadoPedido: async (_, { pedidoId, nuevoEstado }) => {
      const doc = await PedidoModel.findById(pedidoId);
      if (!doc) {
        throw new Error("El pedido no existe.");
      }

      // Ambos estados deben existir en el catalogo, y la transicion tambien
      // se valida contra lo que dice el catalogo.
      const estadoActual = await obtenerEstadoDominio(doc.estado);
      const estadoNuevo = await obtenerEstadoDominio(nuevoEstado);
      estadoActual.validarTransicion(estadoNuevo.clave);

      doc.estado = estadoNuevo.clave;
      const actualizado = await doc.save();
      // El reporte de mas vendidos cuenta pedidos ENTREGADO: puede cambiar
      await invalidarCache(clavesCache.productosMasVendidos(actualizado.cafeteriaId));
      return mapPedido(actualizado);
    }
  }
};