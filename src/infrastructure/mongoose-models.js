import mongoose from "mongoose";

const esEntero = {
  validator: Number.isInteger,
  message: "{PATH} debe ser un numero entero."
};

// =================================================
// CATALOGOS
// =================================================

const MonedaSchema = new mongoose.Schema({
  codigo: {
    type: String,
    required: [true, "La moneda necesita un codigo."],
    unique: true,
    uppercase: true,
    trim: true,
    match: [/^[A-Z]{3}$/, "El codigo de moneda debe tener 3 letras (ISO 4217), ej. MXN."]
  },
  nombre: { type: String, required: [true, "La moneda necesita un nombre."] },
  simbolo: { type: String, required: [true, "La moneda necesita un simbolo."] },
  decimales: {
    type: Number,
    required: true,
    default: 2,
    min: 0,
    max: 4,
    validate: esEntero
  },
  activa: { type: Boolean, default: true }
}, { timestamps: true });

export const MonedaModel = mongoose.model("Moneda", MonedaSchema);

const EstadoPedidoSchema = new mongoose.Schema({
  clave: {
    type: String,
    required: [true, "El estado necesita una clave."],
    unique: true,
    uppercase: true,
    trim: true
  },
  nombre: { type: String, required: [true, "El estado necesita un nombre."] },
  orden: { type: Number, required: true, validate: esEntero },
  esInicial: { type: Boolean, default: false },
  esFinal: { type: Boolean, default: false },
  transiciones: [{ type: String, uppercase: true, trim: true }]
}, { timestamps: true });

EstadoPedidoSchema.index(
  { esInicial: 1 },
  { unique: true, partialFilterExpression: { esInicial: true } }
);

export const EstadoPedidoModel = mongoose.model("EstadoPedido", EstadoPedidoSchema);

const EscuelaSchema = new mongoose.Schema({
  clave: {
    type: String,
    required: [true, "La escuela necesita una clave."],
    unique: true,
    uppercase: true,
    trim: true
  },
  nombre: { type: String, required: [true, "La escuela necesita un nombre."] },
  activa: { type: Boolean, default: true }
}, { timestamps: true });

export const EscuelaModel = mongoose.model("Escuela", EscuelaSchema);

const CafeteriaSchema = new mongoose.Schema({
  nombre: { type: String, required: [true, "La cafeteria necesita un nombre."] },
  escuelaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Escuela",
    required: [true, "Debes indicar a que escuela pertenece."]
  },
  activa: { type: Boolean, default: true }
}, { timestamps: true });

CafeteriaSchema.index({ escuelaId: 1, nombre: 1 }, { unique: true });

export const CafeteriaModel = mongoose.model("Cafeteria", CafeteriaSchema);

// =================================================
// DATOS DEL NEGOCIO
// =================================================

const UsuarioSchema = new mongoose.Schema({
  nombre: { type: String, required: [true, "El usuario necesita un nombre."] },
  correo: {
    type: String,
    required: [true, "El correo es obligatorio."],
    unique: true,
    lowercase: true,
    trim: true
  },
  // Hash bcrypt; nunca se guarda ni se devuelve la contrasena en claro.
  // select: false evita que salga en consultas normales.
  passwordHash: {
    type: String,
    required: [true, "El usuario necesita contrasena."],
    select: false
  },
  cafeteriaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Cafeteria",
    required: [true, "El usuario debe pertenecer a una cafeteria/escuela."]
  }
}, { timestamps: true });

export const UsuarioModel = mongoose.model("Usuario", UsuarioSchema);

const DineroSchema = new mongoose.Schema({
  monto: { type: Number, required: true, min: 0 },
  moneda: { type: String, required: true, uppercase: true, trim: true }
}, { _id: false });

const InventarioSchema = new mongoose.Schema({
  stock: {
    type: Number,
    required: true,
    min: [0, "El stock no puede ser negativo."],
    validate: esEntero
  },
  puntoReorden: { type: Number, required: true, min: 0, validate: esEntero },
  cantidadReposicion: { type: Number, required: true, min: 1, validate: esEntero }
}, { _id: false });

const ProductoSchema = new mongoose.Schema({
  nombre: { type: String, required: [true, "El producto necesita un nombre."] },
  precio: { type: DineroSchema, required: [true, "Debes definir un precio."] },
  disponible: { type: Boolean, default: true },
  inventario: { type: InventarioSchema, required: [true, "El producto necesita inventario."] },
  cafeteriaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Cafeteria",
    required: [true, "El producto debe pertenecer a una cafeteria."]
  }
}, { timestamps: true });

export const ProductoModel = mongoose.model("Producto", ProductoSchema);

const ItemPedidoSchema = new mongoose.Schema({
  productoId: { type: mongoose.Schema.Types.ObjectId, ref: "Producto", required: true },
  nombreProducto: { type: String, required: true },
  precioUnitario: { type: DineroSchema, required: true },
  cantidad: { type: Number, required: true, min: 1, validate: esEntero }
}, { _id: false });

const PedidoSchema = new mongoose.Schema({
  usuarioId: { type: mongoose.Schema.Types.ObjectId, ref: "Usuario", required: true },
  cafeteriaId: { type: mongoose.Schema.Types.ObjectId, ref: "Cafeteria", required: true },
  items: [ItemPedidoSchema],
  total: { type: DineroSchema, required: true },
  estado: { type: String, required: true, uppercase: true, trim: true }
}, { timestamps: true });

export const PedidoModel = mongoose.model("Pedido", PedidoSchema);