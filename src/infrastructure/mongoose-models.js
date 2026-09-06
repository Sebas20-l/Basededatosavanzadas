import mongoose from "mongoose";

// -------------------------------------------------
// Cafeteria (multi-tenant: cada escuela es una cafeteria distinta)
// -------------------------------------------------
const CafeteriaSchema = new mongoose.Schema({
  nombre: {
    type: String,
    required: [true, "La cafeteria necesita un nombre."]
  },
  escuela: {
    type: String,
    required: [true, "Debes indicar a que escuela pertenece."]
  },
  activa: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

export const CafeteriaModel = mongoose.model("Cafeteria", CafeteriaSchema);

// -------------------------------------------------
// Usuario
// -------------------------------------------------
const UsuarioSchema = new mongoose.Schema({
  nombre: {
    type: String,
    required: [true, "El usuario necesita un nombre."]
  },
  correo: {
    type: String,
    required: [true, "El correo es obligatorio."],
    unique: true
  },
  cafeteriaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Cafeteria",
    required: [true, "El usuario debe pertenecer a una cafeteria/escuela."]
  }
}, { timestamps: true });

export const UsuarioModel = mongoose.model("Usuario", UsuarioSchema);

// -------------------------------------------------
// Producto
// -------------------------------------------------
const ProductoSchema = new mongoose.Schema({
  nombre: {
    type: String,
    required: [true, "El producto necesita un nombre."]
  },
  precio: {
    type: Number,
    required: [true, "Debes definir un precio."],
    min: [0.01, "El precio debe ser mayor a 0."]
  },
  disponible: {
    type: Boolean,
    default: true
  },
  cafeteriaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Cafeteria",
    required: [true, "El producto debe pertenecer a una cafeteria."]
  }
}, { timestamps: true });

export const ProductoModel = mongoose.model("Producto", ProductoSchema);

// -------------------------------------------------
// Pedido
// -------------------------------------------------
// Incrustacion: los items de un pedido se leen siempre junto con el pedido
// y no crecen despues de creado, por eso viven como subdocumentos.
const ItemPedidoSchema = new mongoose.Schema({
  productoId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Producto",
    required: true
  },
  nombreProducto: { type: String, required: true },
  precioUnitario: { type: Number, required: true, min: 0.01 },
  cantidad: { type: Number, required: true, min: 1 }
}, { _id: false });

// Referenciacion: el pedido referencia al usuario por su id, en lugar de
// incrustarlo, porque el historial de pedidos de un usuario crece sin limite.
// Tambien referencia la cafeteria, para poder filtrar y reportar por escuela
// sin mezclar datos entre distintas cafeterias (multi-tenant).
const PedidoSchema = new mongoose.Schema({
  usuarioId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Usuario",
    required: true
  },
  cafeteriaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Cafeteria",
    required: true
  },
  items: [ItemPedidoSchema],
  total: {
    type: Number,
    required: true,
    min: 0
  },
  estado: {
    type: String,
    enum: ["PENDIENTE", "EN_PREPARACION", "LISTO", "ENTREGADO"],
    default: "PENDIENTE"
  }
}, { timestamps: true });

export const PedidoModel = mongoose.model("Pedido", PedidoSchema);