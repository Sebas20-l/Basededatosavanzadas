// Capa de Dominio (DDD)
// Clases puras de JavaScript, sin dependencias de Mongoose ni de GraphQL.
// Aqui viven las reglas de negocio criticas de "Pide y Recoge".
//
// Los catalogos (monedas, estados de pedido) viven en la base de datos. Aqui solo
// se modelan como objetos con su comportamiento, para que las reglas no dependan
// de valores escritos a mano en el codigo.

// -------------------------------------------------
// Catalogo de monedas
// -------------------------------------------------
export class Moneda {
  constructor(codigo, simbolo, decimales) {
    this.codigo = codigo;
    this.simbolo = simbolo;
    this.decimales = decimales;
  }

  // Regla de negocio: un monto solo puede tener los decimales que admite su
  // moneda (MXN y USD: 2, JPY: 0).
  validarMonto(monto) {
    if (!Number.isFinite(monto)) {
      throw new Error("El monto debe ser un numero valido.");
    }
    const escalado = monto * 10 ** this.decimales;
    if (Math.abs(escalado - Math.round(escalado)) > 1e-6) {
      throw new Error(`La moneda ${this.codigo} admite maximo ${this.decimales} decimales.`);
    }
  }

  // Evita ruido de punto flotante al sumar (0.1 + 0.2 = 0.30000000000000004).
  redondear(monto) {
    const factor = 10 ** this.decimales;
    return Math.round((monto + Number.EPSILON) * factor) / factor;
  }
}

// -------------------------------------------------
// Catalogo de estados de pedido
// -------------------------------------------------
export class EstadoPedido {
  constructor(clave, nombre, transiciones = [], esFinal = false) {
    this.clave = clave;
    this.nombre = nombre;
    this.transiciones = transiciones;
    this.esFinal = esFinal;
  }

  // Regla de negocio: los cambios de estado siguen las transiciones definidas
  // en el catalogo, no un diccionario escrito en el codigo.
  validarTransicion(nuevaClave) {
    if (this.esFinal || !this.transiciones.includes(nuevaClave)) {
      throw new Error(`No se puede pasar el pedido de "${this.clave}" a "${nuevaClave}".`);
    }
  }
}

// -------------------------------------------------
// Inventario por producto
// -------------------------------------------------
export class Inventario {
  constructor(stock, puntoReorden, cantidadReposicion) {
    this.stock = stock;
    this.puntoReorden = puntoReorden;
    this.cantidadReposicion = cantidadReposicion;
  }

  validar() {
    const campos = {
      stock: this.stock,
      puntoReorden: this.puntoReorden,
      cantidadReposicion: this.cantidadReposicion
    };
    for (const [campo, valor] of Object.entries(campos)) {
      if (!Number.isInteger(valor) || valor < 0) {
        throw new Error(`El inventario "${campo}" debe ser un entero mayor o igual a 0.`);
      }
    }
    if (this.cantidadReposicion === 0) {
      throw new Error("La cantidad de reposicion debe ser mayor a 0.");
    }
  }

  // Punto de reorden: el nivel de stock en el que se debe pedir mas producto,
  // antes de que se acabe. Se calcula al leer, asi nunca queda desactualizado.
  requiereReposicion() {
    return this.stock <= this.puntoReorden;
  }
}

// -------------------------------------------------
// Producto
// -------------------------------------------------
// `precio` es { monto, moneda } donde moneda es el codigo del catalogo (MXN, JPY...).
export class Producto {
  constructor(id, nombre, precio, disponible, inventario) {
    this.id = id;
    this.nombre = nombre;
    this.precio = precio;
    this.disponible = disponible;
    this.inventario = inventario;
  }

  validarPrecioPositivo() {
    if (!(this.precio.monto > 0)) {
      throw new Error(`El producto "${this.nombre}" debe tener un precio mayor a 0.`);
    }
  }

  validarInventario() {
    this.inventario.validar();
  }
}

// -------------------------------------------------
// Pedido
// -------------------------------------------------
// `precioUnitario` es { monto, moneda }: el precio congelado al momento de comprar.
export class ItemPedido {
  constructor(productoId, nombreProducto, precioUnitario, cantidad) {
    this.productoId = productoId;
    this.nombreProducto = nombreProducto;
    this.precioUnitario = precioUnitario;
    this.cantidad = cantidad;
  }

  get moneda() {
    return this.precioUnitario.moneda;
  }

  validarCantidad() {
    if (this.cantidad <= 0) {
      throw new Error(`La cantidad de "${this.nombreProducto}" debe ser mayor a 0.`);
    }
  }

  calcularSubtotal() {
    return this.precioUnitario.monto * this.cantidad;
  }
}

export class Pedido {
  constructor(id, usuarioId, items = [], estado = null) {
    this.id = id;
    this.usuarioId = usuarioId;
    this.items = items;
    this.estado = estado; // clave del catalogo de estados
  }

  // Regla de negocio: un pedido no puede crearse vacio.
  validarTieneItems() {
    if (!this.items || this.items.length === 0) {
      throw new Error("El pedido debe contener al menos un producto.");
    }
  }

  // Regla de negocio: un pedido se cobra en una sola moneda.
  // Devuelve el codigo de esa moneda.
  validarUnaSolaMoneda() {
    const monedas = [...new Set(this.items.map(item => item.moneda))];
    if (monedas.length > 1) {
      throw new Error(`Un pedido no puede mezclar monedas (${monedas.join(", ")}).`);
    }
    return monedas[0];
  }

  // Regla de negocio: el total siempre se calcula en el dominio,
  // nunca se confia en un total que mande el cliente.
  calcularTotal(moneda) {
    if (moneda.codigo !== this.validarUnaSolaMoneda()) {
      throw new Error("La moneda del total no coincide con la de los productos.");
    }
    const suma = this.items.reduce((acc, item) => acc + item.calcularSubtotal(), 0);
    return { monto: moneda.redondear(suma), moneda: moneda.codigo };
  }
}