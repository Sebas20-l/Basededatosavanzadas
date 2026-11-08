import mongoose from "mongoose";
import { ROLES, LISTA_ROLES } from "../domain/roles.js";

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

// =================================================
// MULTIEMPRESA: escuela -> negocios -> cafeterias
// =================================================

// Cada escuela es un "tenant": sus datos nunca se mezclan con los de otra.
const EscuelaSchema = new mongoose.Schema({
  clave: {
    type: String,
    required: [true, "La escuela necesita una clave."],
    unique: true,
    uppercase: true,
    trim: true,
    match: [/^[A-Z0-9]{2,12}$/, "La clave debe tener de 2 a 12 letras o numeros (ej. ULSA)."]
  },
  nombre: { type: String, required: [true, "La escuela necesita un nombre."], trim: true },
  ciudad: { type: String, required: [true, "La escuela necesita una ciudad."], trim: true },
  // Codigo que el admin de la escuela comparte con los duenos de las cafeterias
  codigoInvitacion: { type: String, required: true, unique: true, uppercase: true, trim: true },
  activa: { type: Boolean, default: true }
}, { timestamps: true });

export const EscuelaModel = mongoose.model("Escuela", EscuelaSchema);

// Un negocio es la marca de un dueno. Puede operar cafeterias en varias escuelas.
const NegocioSchema = new mongoose.Schema({
  nombre: { type: String, required: [true, "El negocio necesita un nombre."], trim: true },
  duenoId: { type: mongoose.Schema.Types.ObjectId, ref: "Usuario", required: true },
  // Escuelas a las que el negocio entro con un codigo de invitacion
  escuelaIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Escuela" }],
  activo: { type: Boolean, default: true }
}, { timestamps: true });

NegocioSchema.index({ escuelaIds: 1 });

export const NegocioModel = mongoose.model("Negocio", NegocioSchema);

const CafeteriaSchema = new mongoose.Schema({
  nombre: { type: String, required: [true, "La cafeteria necesita un nombre."], trim: true },
  // Donde esta dentro del campus (ej. "Edificio B, planta baja")
  ubicacion: { type: String, trim: true, default: "" },
  escuelaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Escuela",
    required: [true, "Debes indicar a que escuela pertenece."]
  },
  negocioId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Negocio",
    required: [true, "Debes indicar a que negocio pertenece."]
  },
  activa: { type: Boolean, default: true }
}, { timestamps: true });

CafeteriaSchema.index({ escuelaId: 1, nombre: 1 }, { unique: true });
CafeteriaSchema.index({ negocioId: 1 });

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
  rol: {
    type: String,
    required: [true, "El usuario necesita un rol."],
    enum: { values: LISTA_ROLES, message: "El rol \"{VALUE}\" no existe." }
  },
  // Todos pertenecen a una escuela, excepto el admin de la plataforma
  escuelaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Escuela",
    required: [
      function () { return this.rol !== ROLES.ADMIN_PLATAFORMA; },
      "El usuario debe pertenecer a una escuela."
    ]
  },
  // Solo JEFE y VENDEDOR
  negocioId: { type: mongoose.Schema.Types.ObjectId, ref: "Negocio" },
  // Solo VENDEDOR: la cafeteria donde atiende
  cafeteriaId: { type: mongoose.Schema.Types.ObjectId, ref: "Cafeteria" }
}, { timestamps: true });

UsuarioSchema.index({ escuelaId: 1, rol: 1 });

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
  // ---- Datos para mostrar el menu en la app ----
  descripcion: { type: String, default: "", trim: true },
  // La app agrupa el menu por categoria (ej. "Bebidas", "Alimentos", "Combos", "Extras")
  categoria: { type: String, default: "Menu", trim: true },
  // URL completa de la imagen en Cloudinary (las imagenes viven alla, aqui solo su direccion)
  imagenUrl: {
    type: String,
    default: "",
    trim: true,
    validate: {
      validator: v => !v || /^https:\/\//.test(v),
      message: "La imagen debe ser una URL https."
    }
  },
  destacado: { type: Boolean, default: false },
  // Etiqueta corta opcional (ej. "Nuevo", "Mas vendido")
  etiqueta: { type: String, default: "", trim: true },
  // Minutos que tarda en prepararse una orden; sirve para calcular la hora de recogida
  tiempoPreparacionMin: {
    type: Number,
    default: 5,
    min: [1, "El tiempo de preparacion debe ser de al menos 1 minuto."],
    max: [120, "El tiempo de preparacion no puede pasar de 120 minutos."],
    validate: esEntero
  },
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

// Cada cambio de estado queda registrado: quien lo hizo y cuando
const CambioEstadoSchema = new mongoose.Schema({
  estado: { type: String, required: true },
  fecha: { type: Date, required: true, default: Date.now },
  usuarioId: { type: mongoose.Schema.Types.ObjectId, ref: "Usuario" }
}, { _id: false });

const PedidoSchema = new mongoose.Schema({
  usuarioId: { type: mongoose.Schema.Types.ObjectId, ref: "Usuario", required: true },
  cafeteriaId: { type: mongoose.Schema.Types.ObjectId, ref: "Cafeteria", required: true },
  // Copias de la cafeteria para que los reportes por escuela o negocio no
  // tengan que hacer $lookup
  escuelaId: { type: mongoose.Schema.Types.ObjectId, ref: "Escuela" },
  negocioId: { type: mongoose.Schema.Types.ObjectId, ref: "Negocio" },
  items: [ItemPedidoSchema],
  total: { type: DineroSchema, required: true },
  estado: { type: String, required: true, uppercase: true, trim: true },
  historial: [CambioEstadoSchema],
  // ---- Pickup ----
  tiempoEstimadoMin: { type: Number, min: 0 },
  horaRecogida: { type: Date },
  // Codigo que el comprador muestra al recoger (solo el lo ve)
  codigoRecogida: { type: String },
  notas: { type: String, trim: true, default: "", maxlength: [200, "Las notas no pueden pasar de 200 caracteres."] }
}, { timestamps: true });

PedidoSchema.index({ cafeteriaId: 1, estado: 1, horaRecogida: 1 });
PedidoSchema.index({ usuarioId: 1, createdAt: -1 });

export const PedidoModel = mongoose.model("Pedido", PedidoSchema);