import { UsuarioModel, ProductoModel, PedidoModel } from "../infrastructure/mongoose-models.js";
import { Producto, ItemPedido, Pedido } from "../domain/entities.js";

function mapUsuario(doc) {
  return { id: doc._id, nombre: doc.nombre, correo: doc.correo };
}

function mapProducto(doc) {
  return { id: doc._id, nombre: doc.nombre, precio: doc.precio, disponible: doc.disponible };
}

function mapPedido(doc) {
  return {
    id: doc._id,
    usuarioId: doc.usuarioId,
    items: doc.items,
    total: doc.total,
    estado: doc.estado
  };
}

export const resolvers = {
  Query: {
    productos: async () => {
      const docs = await ProductoModel.find({});
      return docs.map(mapProducto);
    },

    producto: async (_, { id }) => {
      const doc = await ProductoModel.findById(id);
      return doc ? mapProducto(doc) : null;
    },

    pedido: async (_, { id }) => {
      const doc = await PedidoModel.findById(id);
      return doc ? mapPedido(doc) : null;
    },

    pedidosPorUsuario: async (_, { usuarioId }) => {
      const docs = await PedidoModel.find({ usuarioId });
      return docs.map(mapPedido);
    },

    // Pipeline de agregacion: productos mas vendidos, calculado
    // directamente en MongoDB, sin traer todos los pedidos a Node.js.
    productosMasVendidos: async () => {
      const resultado = await PedidoModel.aggregate([
        // Etapa 1: solo pedidos que ya se entregaron cuentan como venta real
        { $match: { estado: "ENTREGADO" } },
        // Etapa 2: aplanar el arreglo de items incrustado
        { $unwind: "$items" },
        // Etapa 3: agrupar por producto y acumular metricas
        {
          $group: {
            _id: "$items.nombreProducto",
            unidadesVendidas: { $sum: "$items.cantidad" },
            ingresosTotales: {
              $sum: { $multiply: ["$items.cantidad", "$items.precioUnitario"] }
            }
          }
        },
        // Etapa 4: ordenar del mas vendido al menos vendido
        { $sort: { unidadesVendidas: -1 } }
      ]);

      return resultado.map(item => ({
        nombreProducto: item._id,
        unidadesVendidas: item.unidadesVendidas,
        ingresosTotales: item.ingresosTotales
      }));
    }
  },

  Mutation: {
    registrarUsuario: async (_, { nombre, correo }) => {
      const doc = await new UsuarioModel({ nombre, correo }).save();
      return mapUsuario(doc);
    },

    registrarProducto: async (_, { nombre, precio, disponible }) => {
      // Validacion de dominio antes de persistir
      const productoDominio = new Producto(null, nombre, precio, disponible ?? true);
      productoDominio.validarPrecioPositivo();

      const doc = await new ProductoModel({ nombre, precio, disponible: disponible ?? true }).save();
      return mapProducto(doc);
    },

    crearPedido: async (_, { usuarioId, items }) => {
      const usuario = await UsuarioModel.findById(usuarioId);
      if (!usuario) {
        throw new Error("El usuario no existe.");
      }

      // Construir los items reales consultando precio y disponibilidad actual
      const itemsPedido = [];
      for (const entrada of items) {
        const producto = await ProductoModel.findById(entrada.productoId);
        if (!producto) {
          throw new Error(`El producto ${entrada.productoId} no existe.`);
        }
        if (!producto.disponible) {
          throw new Error(`El producto "${producto.nombre}" no está disponible.`);
        }

        const item = new ItemPedido(producto._id, producto.nombre, producto.precio, entrada.cantidad);
        item.validarCantidad();
        itemsPedido.push(item);
      }

      // Reglas de dominio: el pedido no puede ir vacio y el total se calcula aqui,
      // nunca se confia en un total mandado desde el cliente.
      const pedidoDominio = new Pedido(null, usuarioId, itemsPedido);
      pedidoDominio.validarTieneItems();
      const total = pedidoDominio.calcularTotal();

      const doc = await new PedidoModel({
        usuarioId,
        items: itemsPedido.map(i => ({
          productoId: i.productoId,
          nombreProducto: i.nombreProducto,
          precioUnitario: i.precioUnitario,
          cantidad: i.cantidad
        })),
        total,
        estado: "PENDIENTE"
      }).save();

      return mapPedido(doc);
    },

    actualizarEstadoPedido: async (_, { pedidoId, nuevoEstado }) => {
      const doc = await PedidoModel.findById(pedidoId);
      if (!doc) {
        throw new Error("El pedido no existe.");
      }

      // Regla de dominio: solo se permiten transiciones de estado logicas
      const pedidoDominio = new Pedido(doc._id, doc.usuarioId, doc.items, doc.estado);
      pedidoDominio.validarCambioEstado(nuevoEstado);

      doc.estado = nuevoEstado;
      const actualizado = await doc.save();
      return mapPedido(actualizado);
    }
  }
};
