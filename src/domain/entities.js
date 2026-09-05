// Capa de Dominio (DDD)
// Clases puras de JavaScript, sin dependencias de Mongoose ni de GraphQL.
// Aqui viven las reglas de negocio criticas de "Pide y Recoge".

export class Producto {
  constructor(id, nombre, precio, disponible) {
    this.id = id;
    this.nombre = nombre;
    this.precio = precio;
    this.disponible = disponible;
  }

  validarPrecioPositivo() {
    if (this.precio <= 0) {
      throw new Error(`El producto "${this.nombre}" debe tener un precio mayor a 0.`);
    }
  }
}

export class ItemPedido {
  constructor(productoId, nombreProducto, precioUnitario, cantidad) {
    this.productoId = productoId;
    this.nombreProducto = nombreProducto;
    this.precioUnitario = precioUnitario;
    this.cantidad = cantidad;
  }

  validarCantidad() {
    if (this.cantidad <= 0) {
      throw new Error(`La cantidad de "${this.nombreProducto}" debe ser mayor a 0.`);
    }
  }

  calcularSubtotal() {
    return this.precioUnitario * this.cantidad;
  }
}

export class Pedido {
  constructor(id, usuarioId, items = [], estado = "PENDIENTE") {
    this.id = id;
    this.usuarioId = usuarioId;
    this.items = items;
    this.estado = estado;
  }

  // Regla de negocio: un pedido no puede crearse vacio.
  validarTieneItems() {
    if (!this.items || this.items.length === 0) {
      throw new Error("El pedido debe contener al menos un producto.");
    }
  }

  // Regla de negocio: el total siempre se calcula en el dominio,
  // nunca se confia en un total que mande el cliente.
  calcularTotal() {
    return this.items.reduce((acc, item) => acc + item.calcularSubtotal(), 0);
  }

  // Regla de negocio: los cambios de estado deben seguir un orden logico.
  static transicionesValidas() {
    return {
      PENDIENTE: ["EN_PREPARACION"],
      EN_PREPARACION: ["LISTO"],
      LISTO: ["ENTREGADO"],
      ENTREGADO: []
    };
  }

  validarCambioEstado(nuevoEstado) {
    const permitidos = Pedido.transicionesValidas()[this.estado] || [];
    if (!permitidos.includes(nuevoEstado)) {
      throw new Error(`No se puede pasar el pedido de "${this.estado}" a "${nuevoEstado}".`);
    }
  }
}
