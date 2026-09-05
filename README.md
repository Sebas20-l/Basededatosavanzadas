# Pide y Recoge

App para pedir comida de la cafetería desde el celular y recogerla directo, sin hacer fila ni esperar a que te atiendan.

## Requisitos

- Node.js 18+
- Docker Desktop

## Cómo levantar el proyecto

1. Clona el repositorio y entra a la carpeta:
   ```bash
   git clone <url-del-repo>
   cd pide-y-recoge
   ```

2. Copia el archivo de variables de entorno:
   ```bash
   cp .env.example .env
   ```

3. Levanta MongoDB con Docker:
   ```bash
   docker compose up -d
   ```

4. Instala las dependencias:
   ```bash
   npm install
   ```

5. Corre el servidor:
   ```bash
   npm run dev
   ```

6. Abre la URL que aparezca en la terminal (normalmente `http://localhost:4000/`) para usar Apollo Sandbox.

## Estructura del proyecto

```
src/
  domain/              -> Reglas de negocio puras (DDD)
  infrastructure/      -> Conexión a Mongo y esquemas de Mongoose
  resolvers/           -> Lógica de las queries y mutations
  schema.graphql        -> Contrato de la API (SDL)
  index.js              -> Arranque del servidor Apollo
```

## Flujo de trabajo en equipo

1. Antes de programar, `git pull` para traer los últimos cambios.
2. Trabaja en una rama nueva:
   ```bash
   git checkout -b feature/nombre-de-tu-cambio
   ```
3. Sube tus cambios y abre un Pull Request hacia `main`.
4. Avisa al equipo cuando algo nuevo quede en `main` para que hagan `git pull`.

## Pruebas rápidas en Apollo Sandbox

**1. Registrar un producto:**
```graphql
mutation {
  registrarProducto(nombre: "Torta de jamón", precio: 35) {
    id
    nombre
  }
}
```

**2. Registrar un usuario:**
```graphql
mutation {
  registrarUsuario(nombre: "Ana", correo: "ana@lasalle.edu.mx") {
    id
    nombre
  }
}
```

**3. Crear un pedido:**
```graphql
mutation {
  crearPedido(usuarioId: "PEGA_AQUI_EL_ID_DEL_USUARIO", items: [
    { productoId: "PEGA_AQUI_EL_ID_DEL_PRODUCTO", cantidad: 2 }
  ]) {
    id
    total
    estado
  }
}
```

**4. Marcar el pedido como entregado (para que cuente en el reporte):**
```graphql
mutation {
  actualizarEstadoPedido(pedidoId: "PEGA_AQUI_EL_ID_DEL_PEDIDO", nuevoEstado: "EN_PREPARACION") {
    estado
  }
}
```
Repite subiendo el estado paso a paso: `EN_PREPARACION` → `LISTO` → `ENTREGADO`.

**5. Ver el reporte de productos más vendidos:**
```graphql
query {
  productosMasVendidos {
    nombreProducto
    unidadesVendidas
    ingresosTotales
  }
}
```
