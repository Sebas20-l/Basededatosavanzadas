# Pide y Recoge — Documentación técnica del Tercer Parcial

**Materia:** Bases de Datos Avanzadas  
**Proyecto:** *CafeEnLinea*, una app para pedir comida en la cafetería de la escuela y recogerla sin hacer fila.  
**Repositorio:** https://github.com/Sebas20-l/Basededatosavanzadas

#### Jiménez Villegas Mario Raúl 14599
#### Loya Rivas Cristhian 15186
#### Nevarez Romano Sebastian 14970

---

## Índice

- [A. Sección teórica](#a-sección-teórica)
  - [1. Arquitectura y topología de contenedores (Docker)](#1-arquitectura-y-topología-de-contenedores-docker)
  - [2. Modelo de autorización basado en grafos (RBAC con Neo4j y Cypher)](#2-modelo-de-autorización-basado-en-grafos-rbac-con-neo4j-y-cypher)
  - [3. Justificación de paradigmas NoSQL](#3-justificación-de-paradigmas-nosql)
  - [4. Diagrama de secuencia integral (UML)](#4-diagrama-de-secuencia-integral-uml)
- [B. Sección práctica](#b-sección-práctica)
  - [1. Capa de velocidad: Redis y Cache-Aside](#1-capa-de-velocidad-redis-y-patrón-cache-aside)
  - [2. Autenticación híbrida: JWT y sesiones con TTL en Redis](#2-autenticación-híbrida-jwt-y-sesiones-con-ttl-en-redis)
  - [3. API Gateway (GraphQL) y persistencia (MongoDB)](#3-api-gateway-graphql-y-persistencia-transaccional-mongodb)
  - [4. Telemetría de seguridad asíncrona: RabbitMQ → Worker → ScyllaDB](#4-telemetría-de-seguridad-asíncrona-rabbitmq--worker--scylladb)
- [C. Guía de la demostración en vivo](#c-guía-de-la-demostración-en-vivo)
- [D. Relación con la rúbrica](#d-relación-con-la-rúbrica)

---

# A. Sección teórica

## 1. Arquitectura y topología de contenedores (Docker)

La infraestructura se describe en `docker-compose.yml`. La **API GraphQL** (Apollo Server) y el **worker de auditoría** corren en contenedores propios dentro de la red privada **`bda-network`** (driver `bridge`). Corren en contenedores porque el driver oficial de ScyllaDB (`@scylladb/driver`) solo funciona en Linux. Las bases de datos se usan como servicios administrados en la nube y se conectan con las variables del `.env`: MongoDB Atlas, Upstash Redis, Neo4j Aura, CloudAMQP y ScyllaDB Cloud. Cada una tiene además un **contenedor local de respaldo** que se activa con un perfil de Compose, para trabajar sin internet y para la defensa en vivo.

### Diagrama de topología

```mermaid
flowchart LR
    subgraph Cliente
        S["Apollo Sandbox / App móvil"]
    end

    subgraph NET["Red Docker privada: bda-network (bridge)"]
        API["bda-api<br/>Apollo Server (Node.js)<br/>:4000"]
        W["bda-worker<br/>worker-auditoria.js"]
        RMQ[["rabbitmq<br/>rabbitmq:3.13-management<br/>:5672 / :15672<br/>(perfil rabbitmq-local)"]]
        SC[("bda-scylla<br/>scylladb/scylla:6.2<br/>:9042<br/>(perfil scylla-local)")]
    end

    subgraph NUBE["Servicios administrados (o perfil bd-local)"]
        M[("MongoDB Atlas")]
        R[("Upstash Redis")]
        N[("Neo4j Aura")]
    end

    S -- "HTTP POST /graphql<br/>Authorization: Bearer JWT" --> API
    API -- "Mongoose<br/>datos y agregaciones" --> M
    API -- "node-redis<br/>caché, sesiones, cola de cocina" --> R
    API -. "Bolt<br/>permisos y menú" .-> N
    API -- "CQL<br/>bitácora de pedidos" --> SC
    API -- "AMQP<br/>eventos de seguridad<br/>(fire-and-forget)" --> RMQ
    RMQ -- "AMQP<br/>prefetch 50, ack manual" --> W
    W -- "CQL<br/>auditoria.logs_eventos" --> SC
```

### Puertos y servicios

| Contenedor | Imagen | Puerto | Protocolo / función |
|---|---|---|---|
| `bda-api` | `Dockerfile` (node:24-slim) | **4000** | API Gateway GraphQL (Apollo Sandbox en `http://localhost:4000`). |
| `bda-worker` | `Dockerfile` (node:24-slim) | — | Consume la cola `eventos-seguridad` y escribe en ScyllaDB. No expone puertos. |
| `rabbitmq` | `rabbitmq:3.13-management` | **5672** | Protocolo **AMQP 0-9-1** (`amqplib`): productor (API) y consumidor (worker). |
| `rabbitmq` | `rabbitmq:3.13-management` | **15672** | **RabbitMQ Management UI** (`guest` / `guest`): colas, mensajes listos y sin confirmar. |
| `bda-scylla` | `scylladb/scylla:6.2` | **9042** | Protocolo **CQL** binario (`@scylladb/driver`, `cqlsh`). |
| `bda-mongodb` | `mongo:8.0` | **27017** | Protocolo nativo de MongoDB (Mongoose). Respaldo de Atlas. |
| `bda-redis-stack` | `redis/redis-stack` | **6379 / 8001** | RESP (`node-redis`) y **RedisInsight**. Respaldo de Upstash. |
| `bda-neo4j` | `neo4j:5.26` | **7474 / 7687** | **Neo4j Browser** (HTTP) y protocolo **Bolt**. Respaldo de Aura. |

### Red, perfiles y persistencia

- **Red privada `bda-network` (bridge):** Docker crea un segmento de red aislado con DNS interno. Dentro de la red, cada contenedor encuentra a los demás por su nombre de servicio (`rabbitmq`, `scylla`, `neo4j`…). Desde fuera solo se alcanzan los puertos publicados.
- **Perfiles de Compose:** `scylla-local`, `rabbitmq-local` y `bd-local` levantan los contenedores de respaldo. Se combinan con `COMPOSE_PROFILES=scylla-local,rabbitmq-local` en el `.env`. Sin perfiles solo se levantan `api` y `worker`.
- **Volúmenes nombrados** (`scylla_data`, `rabbitmq_data`, …): los datos y la **cola durable** sobreviven a reinicios y a `docker compose down`. Solo se pierden con `docker compose down -v`.
- **`restart: unless-stopped`:** si Docker se reinicia, los contenedores vuelven solos. Un `docker stop` manual se respeta, y eso es lo que permite el simulacro de resiliencia.
- **Credenciales:** viven en el `.env`, que está en `.gitignore`. Nunca van en el repositorio.

---

## 2. Modelo de autorización basado en grafos (RBAC con Neo4j y Cypher)

La autorización vive en Neo4j en dos capas complementarias:

| Capa | Catálogo | Servicio | Pregunta que responde |
|---|---|---|---|
| **Rutas y menú del frontend** | `neo4j/init-rbac.cql` | `src/services/rbac.service.js` | ¿Puede abrir esta pantalla? ¿Qué botones ve? |
| **Operaciones del API** (con alcance multiempresa) | `neo4j/rbac.cypher` | `src/infrastructure/autorizacion.js` | ¿Puede ejecutar esta query o mutation **en esta** escuela, negocio o cafetería? |

Las dos usan la misma idea (rol → herencia de longitud variable → permiso) y comparten los nodos de usuario: el mismo nodo lleva las etiquetas `:Usuario:User`.

### Diseño del grafo de rutas y menú (`init-rbac.cql`)

**Nodos**

| Etiqueta | Propiedades | Ejemplos |
|---|---|---|
| `:User` | `id` (el `_id` de MongoDB) | el mismo nodo `:Usuario` que copia `grafo.js` desde MongoDB |
| `:Role` | `name`, `descripcion` | `INVITADO`, `CLIENTE`, `VENDEDOR`, `JEFE`, `ADMIN_ESCUELA`, `ADMIN_PLATAFORMA` |
| `:Route` | `path`, `descripcion` | `/cocina/cola`, `/reportes/ventas` |
| `:MenuNode` | `id`, `title`, `order` | `cocina` → `cocina-cola` |

**Relaciones**

| Relación | Significado |
|---|---|
| `(:User)-[:HAS_ROLE]->(:Role)` | El usuario tiene asignado ese rol. |
| `(:Role)-[:INHERITS]->(:Role)` | **Jerarquía:** el rol superior recibe todo lo del inferior. |
| `(:Role)-[:CAN_ACCESS]->(:Route)` | El rol puede abrir esa ruta. Se liga **solo al rol más bajo** que la usa. |
| `(:Role)-[:CAN_VIEW_MENU]->(:MenuNode)` | El rol ve ese botón del menú. |
| `(:MenuNode)-[:HAS_CHILD]->(:MenuNode)` | Submenús. |
| `(:MenuNode)-[:NAVIGATES_TO]->(:Route)` | A dónde lleva el clic. El menú está desacoplado de las rutas. |

**Restricciones de unicidad activas:** `unique_user_id` (`User.id`), `unique_role_name` (`Role.name`), `unique_route_path` (`Route.path`) y `unique_menu_id` (`MenuNode.id`).

**Jerarquía (grafo acíclico dirigido, 5 niveles):**

```mermaid
flowchart TB
    AP["ADMIN_PLATAFORMA"] -- INHERITS --> J["JEFE"]
    AP -- INHERITS --> AE["ADMIN_ESCUELA"]
    J -- INHERITS --> V["VENDEDOR"]
    V -- INHERITS --> C["CLIENTE"]
    AE -- INHERITS --> C
    C -- INHERITS --> I["INVITADO"]
```

### Matriz Maestra RBAC

**D** = asignación directa (`CAN_ACCESS`); **H** = la recibe por herencia (`INHERITS*`); **—** = sin acceso. La columna *Operaciones GraphQL* indica qué llama esa pantalla y, entre paréntesis, el permiso con el que el resolver la protege (capa `rbac.cypher`; responde **403** si no lo tiene).

| Ruta técnica (`:Route`) | Operaciones GraphQL (permiso del resolver) | INVITADO | CLIENTE | VENDEDOR | JEFE | ADMIN_ESCUELA | ADMIN_PLATAFORMA | Visibilidad en el menú (`:MenuNode`) |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| `/onboarding` | — (pública) | D | H | H | H | H | H | sin botón |
| `/login` | `login` (pública) | D | H | H | H | H | H | sin botón |
| `/registro` | `registro` (pública) | D | H | H | H | H | H | sin botón |
| `/terminos` | `terminos` (pública) | D | H | H | H | H | H | Explorar › Términos y condiciones |
| `/escuelas` | `catalogoEscuelas`, `cafeteriasPorEscuela` (públicas) | D | H | H | H | H | H | Explorar › Escuelas y cafeterías |
| `/menu` | `menuPorCategoria`, `productosPorCafeteria` (públicas) | D | H | H | H | H | H | Comprar › Menú (desde CLIENTE) |
| `/inicio` | `me` (sesión) | — | D | H | H | H | H | Inicio |
| `/carrito` | `estimarRecogida`, `crearPedido` (`PEDIDO_CREAR`) | — | D | H | H | H | H | Comprar › Carrito |
| `/pedidos` | `misPedidos` (`PEDIDO_LEER_PROPIOS`), `cancelarPedido` (`PEDIDO_CANCELAR_PROPIO`) | — | D | H | H | H | H | Mis pedidos › Pedidos |
| `/notificaciones` | `misNotificaciones` (sesión) | — | D | H | H | H | H | Mis pedidos › Notificaciones |
| `/perfil` | `me` (sesión) | — | D | H | H | H | H | Perfil |
| `/perfil/seguridad` | `logout` (sesión) | — | D | H | H | H | H | sin botón |
| `/cocina/cola` | `colaCafeteria` (`PEDIDO_LEER_CAFETERIA`), `actualizarEstadoPedido` (`PEDIDO_CAMBIAR_ESTADO`) | — | — | D | H | — | H | Cocina › Cola de pedidos |
| `/cocina/pedidos` | `pedidosPorCafeteria`, `actividadCafeteria` (`PEDIDO_LEER_CAFETERIA`) | — | — | D | H | — | H | Cocina › Pedidos del día |
| `/productos` | `actualizarProducto`, `cambiarDisponibilidadProducto` (`PRODUCTO_GESTIONAR`) | — | — | D | H | — | H | Menú de la cafetería › Productos |
| `/productos/nuevo` | `registrarProducto` (`PRODUCTO_GESTIONAR`) | — | — | D | H | — | H | Menú de la cafetería › Agregar platillo |
| `/inventario/reponer` | `productosPorReponer`, `reponerInventario` (`INVENTARIO_REPONER`) | — | — | D | H | — | H | Menú de la cafetería › Reponer inventario |
| `/negocio/cafeterias` | `registrarCafeteria` (`CAFETERIA_REGISTRAR`) | — | — | — | D | — | H | Mi negocio › Cafeterías |
| `/negocio/vendedores` | `registrarVendedor` (`VENDEDOR_REGISTRAR`) | — | — | — | D | — | H | Mi negocio › Vendedores |
| `/reportes/ventas` | `resumenNegocio`, `tiemposCafeteria` (`REPORTE_VENTAS_LEER`) | — | — | — | D | — | H | Mi negocio › Reporte de ventas |
| `/reportes/horas-pico` | `horasPico` (`REPORTE_VENTAS_LEER`) | — | — | — | D | — | H | Mi negocio › Horas pico |
| `/reportes/mas-vendidos` | `productosMasVendidos` (`REPORTE_VENTAS_LEER`) | — | — | — | D | — | H | Menú de la cafetería › Más vendidos (solo JEFE) |
| `/escuela/invitacion` | `codigoInvitacion`, `regenerarCodigoInvitacion` (`ESCUELA_ADMINISTRAR`) | — | — | — | — | D | H | Mi escuela › Código de invitación |
| `/escuela/reporte` | `resumenEscuela` (`REPORTE_ESCUELA_LEER`) | — | — | — | — | D | H | Mi escuela › Reporte de la escuela |
| `/plataforma/escuelas` | `cambiarEstadoEscuela` (`PLATAFORMA_ADMINISTRAR`) | — | — | — | — | — | D | Plataforma › Escuelas |
| `/plataforma/monedas` | `registrarMoneda` (`PLATAFORMA_ADMINISTRAR`) | — | — | — | — | — | D | Plataforma › Monedas |

**Visibilidad del menú por rol** (resultado de `miMenu`, usuarios demo con contraseña `demo123`):

| Usuario | Rol | Menús raíz que recibe |
|---|---|---|
| *(sin sesión)* | INVITADO | Explorar |
| `demo@ulsa.mx` | CLIENTE | + Inicio, Comprar, Mis pedidos, Perfil |
| `vendedor@ulsa.mx` | VENDEDOR | + Cocina, Menú de la cafetería (3 hijos) |
| `jefe@ulsa.mx` | JEFE | + Mi negocio, y *Más vendidos* dentro de Menú de la cafetería |
| `admin@ulsa.mx` | ADMIN_ESCUELA | lo de CLIENTE + Mi escuela |
| `admin@cafeenlinea.mx` | ADMIN_PLATAFORMA | todo + Plataforma |

### Servicio `rbac.service.js`

**`validarAccesoRuta(userId, path)`**: recorre la herencia con **longitud variable** `[:INHERITS*0..]` (el rol mismo o cualquiera de los que hereda, a cualquier profundidad). Sin sesión usa el rol `INVITADO`.

```cypher
MATCH (u:User {id: $userId})-[:HAS_ROLE]->(r:Role)
MATCH (r)-[:INHERITS*0..]->(effectiveRole:Role)-[:CAN_ACCESS]->(rt:Route {path: $path})
RETURN count(rt) > 0 AS autorizado
```

**`obtenerMenuUsuario(userId)`**: junta **todos** los roles efectivos del usuario y después filtra cada submenú contra ese conjunto. Así el JEFE ve *Más vendidos* (que es de JEFE) dentro de *Menú de la cafetería* (que es de VENDEDOR).

```cypher
MATCH (u:User {id: $userId})-[:HAS_ROLE]->(r:Role)
MATCH (r)-[:INHERITS*0..]->(effectiveRole:Role)
WITH collect(DISTINCT effectiveRole) AS roles
UNWIND roles AS rol
MATCH (rol)-[:CAN_VIEW_MENU]->(parent:MenuNode)
WHERE NOT ()-[:HAS_CHILD]->(parent)
WITH DISTINCT parent, roles
OPTIONAL MATCH (parent)-[:NAVIGATES_TO]->(rtParent:Route)
OPTIONAL MATCH (parent)-[:HAS_CHILD]->(child:MenuNode)
  WHERE EXISTS { MATCH (permitido:Role)-[:CAN_VIEW_MENU]->(child) WHERE permitido IN roles }
OPTIONAL MATCH (child)-[:NAVIGATES_TO]->(rtChild:Route)
RETURN parent, rtParent.path, collect(child), ...
```

Se exponen en GraphQL como `miMenu`, `puedoAcceder(path)` y `misRutas` (`src/resolvers/rbac.js`).

### Intercepción en los resolvers (403 Forbidden)

Cada resolver protegido llama a `autorizar(contexto, "<PERMISO>", alcance)` **antes** de tocar MongoDB. La consulta recorre la misma idea de herencia en el catálogo de operaciones (`rbac.cypher`) y además exige el camino de **alcance multiempresa**: que el usuario trabaje en esa cafetería, sea dueño de su negocio o administre su escuela.

```cypher
MATCH (u:Usuario {id: $usuarioId})
OPTIONAL MATCH (u)-[:TIENE_ROL]->(:Rol)-[:HEREDA_DE*0..]->(:Rol)-[:TIENE_PERMISO]->(p:Permiso {clave: $permiso})
... AND EXISTS { (u)-[:DUENO_DE]->(:Negocio)-[:OPERA]->(:Cafeteria {id: $cafeteriaId}) } ...
```

```js
registrarProducto: async (_, { cafeteriaId, ... }, contexto) => {
  await autorizar(contexto, "PRODUCTO_GESTIONAR", { cafeteriaId });   // 401 / 403
  // ... solo si pasa, se escribe en MongoDB
}
```

Si el grafo no da el permiso, el Gateway corta la petición y **no se escribe nada**. La respuesta es un error tipado de GraphQL con estado HTTP 403:

```json
{ "errors": [{ "message": "No tienes permiso para PRODUCTO_GESTIONAR en este recurso.",
               "extensions": { "code": "FORBIDDEN" } }], "data": null }
```

Cada respuesta del grafo se guarda en Redis 5 minutos (`permiso:<usuario>:<permiso>:<alcance>`) y se borra cuando cambian las relaciones del usuario.

### Consultas de verificación en Cypher

Están al final de `neo4j/init-rbac.cql` para pegarlas en Neo4j Browser:

```cypher
// Jerarquía completa de roles
MATCH p = (:Role)-[:INHERITS*]->(:Role) RETURN p;

// ¿El grafo de herencia es acíclico? (debe regresar 0)
MATCH (r:Role)-[:INHERITS*1..]->(r) RETURN count(r) AS ciclos;

// Rutas efectivas de cada rol (propias + heredadas)
MATCH (r:Role)-[:INHERITS*0..]->(:Role)-[:CAN_ACCESS]->(rt:Route)
RETURN r.name AS rol, count(DISTINCT rt) AS rutas, collect(DISTINCT rt.path) AS paths
ORDER BY rutas;

// Árbol de menú con a dónde navega cada botón
MATCH p = (:MenuNode)-[:HAS_CHILD]->(:MenuNode)-[:NAVIGATES_TO]->(:Route) RETURN p;
```

### Index-Free Adjacency

Neo4j es una base de datos de **grafos nativa** y almacena sus datos con *index-free adjacency*: cada nodo guarda punteros físicos directos a sus relaciones, y cada relación guarda punteros a su nodo origen y a su nodo destino. Por eso, pasar de un nodo a su vecino cuesta **O(1)** y no requiere consultar ningún índice global.

En una base relacional, la misma verificación (`usuarios ⋈ usuario_rol ⋈ roles ⋈ rol_hereda ⋈ rol_ruta ⋈ rutas`) necesita un `JOIN` por cada salto. Cada `JOIN` busca en un índice B-tree con costo **O(log n)**, que crece con el tamaño de **toda la tabla**. Además, la jerarquía de profundidad variable exige un `WITH RECURSIVE`.

En Neo4j, el índice de la restricción de unicidad solo se usa una vez, para encontrar el nodo de partida (`User {id}`). A partir de ahí la consulta solo recorre punteros, y su costo depende del **número de relaciones que realmente toca**, no del total de usuarios o rutas almacenados. Así, la autorización mantiene una latencia estable aunque el sistema crezca a muchas escuelas, cafeterías y usuarios.

---

## 3. Justificación de paradigmas NoSQL

**MongoDB: persistencia transaccional y fuente de verdad histórica.** Es la base donde viven de forma permanente las escuelas, cafeterías, usuarios, productos y pedidos. Su modelo documental encaja con el dominio: un `Pedido` guarda incrustados sus `items` con el precio congelado al momento de la compra, así que el historial de ventas no cambia aunque después cambie el precio del producto. MongoDB ofrece transacciones ACID multi-documento (en replica set, como Atlas): `crearPedido` descuenta el stock de varios productos y crea el pedido en una sola transacción que se revierte si falta inventario. Su *aggregation pipeline* (`$match` → `$unwind` → `$group` → `$sort`) genera el reporte de productos más vendidos directamente en la base, sin traer los datos a la aplicación. Además, Mongoose aplica un esquema con validaciones (stock entero y no negativo, moneda ISO de 3 letras), lo que da flexibilidad sin perder integridad.

**Redis Stack: caché de lectura de alta velocidad y estado temporal de las sesiones.** Redis guarda los datos en memoria RAM con estructuras clave-valor, así que responde en menos de un milisegundo, contra los 10 a 20 ms de una consulta a MongoDB. Se usa en dos papeles. Primero, como **caché Cache-Aside** de las lecturas más frecuentes (menú de la cafetería, catálogos, reporte de ventas), lo que quita carga a MongoDB en horas pico, cuando todos los alumnos abren el menú al mismo tiempo. Segundo, como **almacén de sesiones** (`sesion:<jti>`). Su **TTL nativo** (`SET ... EX`) hace que la sesión expire sola, sin procesos de limpieza, y `DEL` permite revocar un JWT al instante. Esto resuelve la mayor debilidad de los JWT, que por sí solos no se pueden invalidar antes de su expiración. Ninguno de estos datos necesita durabilidad: si se pierden, la caché se reconstruye desde MongoDB y el usuario solo vuelve a iniciar sesión.

**Neo4j: representación y evaluación de permisos con relaciones jerárquicas.** La autorización es, por naturaleza, un problema de relaciones: un usuario tiene roles, los roles heredan de otros roles, dan acceso a rutas y operaciones y deciden qué opciones del menú se ven. En un modelo relacional o documental, esto se traduce en JOINs recursivos o en duplicar permisos en cada usuario. En Neo4j es simplemente el grafo, y la pregunta "¿puede este usuario hacer X?" es la búsqueda de una ruta. Gracias a *index-free adjacency*, recorrer la jerarquía de roles (`INHERITS*0..`) tiene un costo proporcional a la profundidad de la ruta y no al tamaño de la base. Además, agregar un rol nuevo (por ejemplo, `SUPERVISOR_ESCUELA` que hereda de `ADMIN_ESCUELA`) consiste en crear un nodo y una relación, sin migrar esquemas ni modificar el código de la API.

**ScyllaDB: escrituras masivas que solo se agregan.** La bitácora de cada pedido, las métricas por hora y la auditoría de seguridad son datos que se escriben muchísimo, nunca se editan y siempre se consultan por la misma llave (un pedido, una cafetería en un día, un tipo de evento en un día). ScyllaDB es una base de **columnas anchas** compatible con CQL: cada tabla se diseña para **una** consulta (*Query-First*) y se particiona por esa llave, así que escribir es agregar al final del *commit log* y leer es ir directo a una partición. Está escrita en C++ con arquitectura *shard-per-core*, lo que le da latencias bajas y estables bajo carga. Los contadores (`counter`) suman ventas por hora sin leer antes, ideal para métricas.

**RabbitMQ: desacoplar el trabajo lento del usuario.** El login no debe esperar a que la auditoría se escriba. La API publica el evento en una cola **durable** con mensajes **persistentes** (*fire-and-forget*) y responde de inmediato. Un worker independiente lo consume a su ritmo. Si el broker cae, la API sigue funcionando en modo degradado (*fail-safe*). Si la base de auditoría cae, los mensajes esperan seguros en la cola.

---

## 4. Diagrama de secuencia integral (UML)

El diagrama separa el **hilo síncrono** que atiende al usuario (izquierda) del **worker en segundo plano** (derecha). El usuario recibe su respuesta en cuanto termina el bloque síncrono: la auditoría nunca está en su camino.

```mermaid
sequenceDiagram
    autonumber
    actor U as Usuario (App / Sandbox)
    participant G as API Gateway<br/>Apollo Server
    participant RD as Redis
    participant M as MongoDB
    participant N as Neo4j
    participant Q as RabbitMQ<br/>cola eventos-seguridad
    participant W as Worker<br/>worker-auditoria.js
    participant S as ScyllaDB<br/>auditoria.logs_eventos

    rect rgb(230, 240, 255)
    note over U,Q: Hilo síncrono: atiende al usuario
    U->>G: mutation login(correo, password)
    G->>M: findOne({correo}) + bcrypt.compare
    alt credenciales inválidas
        G-)Q: sendToQueue(LOGIN_FAILED, persistent: true)
        G-->>U: 401 "Correo o contraseña incorrectos"
    else credenciales válidas
        G->>RD: SET sesion:<jti> <userId> EX 3600
        G-)Q: sendToQueue(LOGIN_SUCCESS {usuario_id, jti}, persistent: true)
        note right of G: Fire-and-forget: no se espera a RabbitMQ.<br/>Si el broker está caído, se omite (fail-safe).<br/>CWE-532: nunca va la contraseña ni el JWT, solo el jti.
        G-->>U: 200 {token, expiraEn}
    end

    U->>G: mutation registrarProducto (Bearer token)
    G->>RD: GET sesion:<jti> (¿sesión viva?)
    G->>RD: GET permiso:<user>:PRODUCTO_GESTIONAR:<cafetería>
    alt no está en caché
        G->>N: rol -[:HEREDA_DE*0..]-> permiso + alcance
        G->>RD: SET permiso:... EX 300
    end
    alt sin permiso
        G-->>U: 403 FORBIDDEN (no se toca MongoDB)
    else con permiso
        G->>M: insertar producto
        G-->>U: 200 {producto}
    end
    end

    rect rgb(235, 250, 235)
    note over Q,S: Worker en segundo plano (proceso independiente)
    Q->>W: entrega mensaje (prefetch 50: máximo 50 sin confirmar)
    W->>W: JSON.parse + validar tipo_evento
    alt mensaje inválido (poison message)
        W-)Q: nack(requeue = false): se descarta
    else mensaje válido
        W->>S: INSERT ... { prepare: true, consistency: LOCAL_QUORUM }
        alt ScyllaDB confirma la escritura
            S-->>W: OK (dato en el commit log)
            W-)Q: ack: el mensaje sale de la cola
        else ScyllaDB no responde
            W-)Q: nack(requeue = true) tras 2 s: el mensaje vuelve a la cola
        end
    end
    end
```

---

# B. Sección práctica

## 1. Capa de velocidad: Redis y patrón Cache-Aside

**Archivos:** `src/infrastructure/redis.js` (cliente) y `src/infrastructure/cache.js` (patrón).

```js
export async function obtenerConCache(clave, cargarDesdeMongo, ttl = CACHE_TTL_SEGUNDOS) {
  const inicioRedis = performance.now();
  const enCache = await redisClient.get(clave);              // 1. buscar en Redis
  const latenciaRedis = performance.now() - inicioRedis;

  if (enCache !== null) {                                     // 2. HIT
    console.log(`[CACHE HIT ] ${clave} -> Redis: ${ms(latenciaRedis)} ms`);
    return JSON.parse(enCache);
  }

  const inicioMongo = performance.now();
  const datos = await cargarDesdeMongo();                     // 3. MISS -> MongoDB
  const latenciaMongo = performance.now() - inicioMongo;

  await redisClient.set(clave, JSON.stringify(datos), { EX: ttl });   // SET ... EX
  console.log(`[CACHE MISS] ${clave} -> MongoDB: ${ms(latenciaMongo)} ms ...`);
  return datos;
}
```

**Consultas con caché** (en `src/resolvers/index.js`):

| Query | Clave en Redis |
|---|---|
| `productosPorCafeteria` | `cache:productos:cafeteria:<id>` |
| `producto` | `cache:producto:<id>` |
| `productosPorReponer` | `cache:productos:reponer:<id>` |
| `productosMasVendidos` (agregación) | `cache:reporte:masvendidos:<id>` |
| `monedas`, `estadosPedido` | `cache:catalogo:monedas`, `cache:catalogo:estados` |

**Invalidación (`redisClient.del`) después de cada escritura:**

| Mutation | Claves que se borran |
|---|---|
| `registrarProducto` | productos de la cafetería y productos por reponer |
| `reponerInventario` | las anteriores y además el producto |
| `crearPedido` | las anteriores para cada producto del pedido (cambió el stock) |
| `actualizarEstadoPedido` | reporte de más vendidos (cuenta pedidos `ENTREGADO`) |
| `registrarMoneda` | catálogo de monedas |

**Medición de latencia.** Se usa `performance.now()`. Esta es una salida real de la consola:

```
[CACHE MISS] cache:productos:cafeteria:6ad6...cd1c -> MongoDB: 11.361 ms (guardado en Redis con TTL de 60 s)
[CACHE HIT ] cache:productos:cafeteria:6ad6...cd1c -> Redis: 0.908 ms
[CACHE MISS] cache:reporte:masvendidos:6ad6...cd1c -> MongoDB: 17.714 ms (guardado en Redis con TTL de 60 s)
[CACHE HIT ] cache:reporte:masvendidos:6ad6...cd1c -> Redis: 0.363 ms
[CACHE DEL ] cache:productos:cafeteria:..., cache:productos:reponer:..., cache:producto:... (1 clave(s) eliminada(s))
```

Las lecturas desde Redis quedan **por debajo de 1.5 ms**.

## 2. Autenticación híbrida: JWT y sesiones con TTL en Redis

**Archivos:** `src/infrastructure/auth.js` (sesiones y middleware) y `src/services/auth.service.js` (login y registro).

- **Login** (`mutation login(correo, password)`): compara la contraseña con su hash `bcrypt` guardado en MongoDB. Si coincide, firma un JWT con `jti = crypto.randomUUID()` y registra la sesión:
  ```
  SET sesion:<jti> <userId> EX 3600
  ```
- **Logout** (`mutation logout`): ejecuta `DEL sesion:<jti>`. El token queda **revocado de inmediato**, aunque su firma y su fecha de expiración sigan siendo válidas.
- **Contexto de GraphQL (middleware):** `construirContexto` corre en **cada petición** antes de los resolvers.
  1. Si la petición no trae `Authorization`, sigue como anónima (sirve para `login` y para consultas públicas).
  2. Si lo trae, revisa el formato `Bearer <token>` y verifica la **firma criptográfica** con `jwt.verify`.
  3. Comprueba que `sesion:<jti>` **siga existiendo en Redis** y que corresponda al mismo usuario.
  4. Si cualquiera de estas validaciones falla, **se rechaza toda la petición** con `UNAUTHENTICATED` y **HTTP 401**.
- **`query me`** está protegida: sin una sesión válida responde 401.

```js
const usuarioEnSesion = await redisClient.get(`sesion:${payload.jti}`);
if (usuarioEnSesion === null || usuarioEnSesion !== payload.sub) {
  throw noAutorizado("La sesion fue cerrada o expiro. Inicia sesion de nuevo.");  // HTTP 401
}
```

## 3. API Gateway (GraphQL) y persistencia transaccional (MongoDB)

- **SDL:** `src/schema.graphql`. Define los tipos (`Escuela`, `Cafeteria`, `Usuario`, `Producto`, `Inventario`, `Pedido`, `Dinero`, `SesionPayload`...), los `input`, las **Queries** (`me`, `productosPorCafeteria`, `productosPorReponer`, `pedidosPorUsuario`, `productosMasVendidos`...) y las **Mutations** (`login`, `logout`, `registrarUsuario`, `registrarProducto`, `reponerInventario`, `crearPedido`, `actualizarEstadoPedido`...).
- **Resolvers:** `src/resolvers/index.js`. Validan las reglas de dominio (`src/domain/entities.js`) antes de persistir con los modelos de Mongoose (`src/infrastructure/mongoose-models.js`).
- **Transacción:** `crearPedido` usa `session.withTransaction`. Descuenta stock con `$inc` condicionado (`stock >= cantidad`) y crea el pedido. Si algo falla, se revierte todo.
- **Agregación (reporte analítico):** `productosMasVendidos(cafeteriaId)`.

```js
PedidoModel.aggregate([
  { $match: { cafeteriaId, estado: "ENTREGADO" } },          // solo ventas completadas de ESA cafetería
  { $unwind: "$items" },                                      // un documento por item
  { $group: {
      _id: { nombreProducto: "$items.nombreProducto", moneda: "$items.precioUnitario.moneda" },
      unidadesVendidas: { $sum: "$items.cantidad" },
      ingresosTotales:  { $sum: { $multiply: ["$items.cantidad", "$items.precioUnitario.monto"] } }
  }},
  { $sort: { unidadesVendidas: -1 } }                         // del más vendido al menos vendido
]);
```

El reporte le dice a la cafetería qué productos vender más y cuánto dinero generan, separado por moneda para no sumar pesos con dólares.

## 4. Telemetría de seguridad asíncrona: RabbitMQ → Worker → ScyllaDB

### Productor (`src/infrastructure/rabbitmq.js`)

- Conexión con `amqplib`. La cola `eventos-seguridad` se declara con **`durable: true`**: sobrevive a un reinicio del broker.
- Cada evento se publica con **`persistent: true`**: RabbitMQ lo guarda en disco, no solo en memoria.
- **Fail-safe:** `emitirEventoSeguridad()` nunca lanza errores ni se espera. Si no hay canal, el evento se omite y el login sigue. Hay listeners de `error` y `close` para que una caída del broker no tumbe a Node.js, con reconexión automática cada 10 s.
- **CWE-532 (información sensible en logs):** el payload solo lleva identificadores opacos: `usuario_id`, `email`, `ip_origen`, `motivo` y, en `metadata`, el **`jti`** de la sesión. Nunca la contraseña, su hash ni el JWT completo.

Eventos que se emiten: `LOGIN_SUCCESS`, `LOGIN_FAILED`, `USER_REGISTERED` (`src/services/auth.service.js`) y `ROLE_CHANGED` (`src/infrastructure/grafo.js`).

### Worker consumidor (`src/worker-auditoria.js`)

- **Contrapresión:** `channel.prefetch(50)`. RabbitMQ no le entrega más de 50 mensajes sin confirmar, así que una avalancha de eventos (por ejemplo, un ataque de fuerza bruta al login) no llena la RAM de Node.js: el resto espera en la cola.
- **No consume hasta que ScyllaDB responde:** si la base no está, el worker reintenta cada 10 s y los mensajes esperan seguros en la cola durable.
- **Confirmación manual (`noAck: false`):** `channel.ack(msg)` se llama **solo después** de que ScyllaDB confirmó el `INSERT`. Si ScyllaDB falla, `channel.nack(msg, false, true)` lo devuelve a la cola tras una pausa de 2 s. Un mensaje imposible de procesar (JSON inválido) se descarta con `nack(msg, false, false)` para no ciclarlo.

### Ingesta en ScyllaDB (`src/infrastructure/auditoria.js`)

Diseño **Query-First** para la consulta *"eventos de tipo X del día D, del más reciente al más antiguo"*:

```sql
CREATE TABLE IF NOT EXISTS auditoria.logs_eventos (
  fecha_dia   date,
  tipo_evento text,
  timestamp   timestamp,
  evento_id   timeuuid,
  usuario_id  text,
  email       text,
  ip_origen   text,
  exito       boolean,
  motivo      text,
  metadata    map<text, text>,
  PRIMARY KEY ((fecha_dia, tipo_evento), timestamp, evento_id)
) WITH CLUSTERING ORDER BY (timestamp DESC, evento_id DESC);
```

- **Clave de partición compuesta `(fecha_dia, tipo_evento)`:** cada día y tipo vive en su propia partición. Ninguna crece sin límite y la carga se reparte entre los nodos.
- **Claves de agrupamiento `timestamp, evento_id`:** ordenan físicamente las filas dentro de la partición. El `timeuuid` desempata eventos del mismo milisegundo para que ninguno sobrescriba a otro.
- **Orden físico descendente:** leer "lo más reciente" no ordena nada en memoria; ya está guardado así en disco.
- **Sentencias preparadas (`{ prepare: true }`):** ScyllaDB compila el `INSERT` una sola vez y después solo recibe los valores en binario. Es más rápido y **evita la inyección de CQL**, porque los valores nunca se pegan al texto de la consulta.
- **Consistencia `LOCAL_QUORUM`:** el `INSERT` responde cuando la mayoría de las réplicas ya escribió el dato en su *commit log*. Solo entonces el worker hace `ack`.

Salida real del worker:

```
🗄️  ScyllaDB listo; tabla auditoria.logs_eventos
📥 Worker escuchando eventos en la cola [eventos-seguridad] (prefetch 50)...
[AUDIT EVENT] [LOGIN_FAILED] - Usuario: nadie@prueba.mx | Resultado: false | Motivo: Usuario inexistente | ... -> ScyllaDB OK
[AUDIT EVENT] [LOGIN_SUCCESS] - Usuario: demo@ulsa.mx | Resultado: true | Motivo: Credenciales válidas | ... -> ScyllaDB OK
```

---

# C. Guía de la demostración en vivo

### Preparación

Para la defensa se usan los contenedores locales de ScyllaDB y RabbitMQ, porque la batería pide `http://localhost:15672` y `docker stop`. En el `.env`:

```
COMPOSE_PROFILES=scylla-local,rabbitmq-local
RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672
SCYLLA_CONTACT_POINTS=
SCYLLA_DATACENTER=datacenter1
SCYLLA_REPLICAS=1
```

```bash
docker compose up -d --build              # API, worker, ScyllaDB y RabbitMQ (ScyllaDB tarda ~1 min la primera vez)
docker compose exec api npm run seed      # catálogos, datos demo y grafo RBAC
docker compose logs -f api worker         # consolas de la API y del worker
```

Usuarios demo (contraseña `demo123`): `demo@ulsa.mx` (CLIENTE), `vendedor@ulsa.mx` (VENDEDOR), `jefe@ulsa.mx` (JEFE), `admin@ulsa.mx` (ADMIN_ESCUELA), `admin@cafeenlinea.mx` (ADMIN_PLATAFORMA). `npm run seed` imprime el `id` de la cafetería demo; ese valor se usa como `cafeteriaId`.

### Prueba 1. Auditoría del grafo en Neo4j Browser

En Neo4j Browser (`http://localhost:7474` con el perfil `bd-local`, o la consola de Neo4j Aura) se ejecutan las consultas de verificación de la sección A.2:

- La jerarquía `INHERITS` entre los seis roles.
- `ciclos = 0`: el grafo es acíclico.
- Las rutas efectivas por rol y el árbol `HAS_CHILD` / `NAVIGATES_TO` del menú.
- `SHOW CONSTRAINTS` muestra las restricciones de unicidad activas.

### Prueba 2. Permisos: 403 Forbidden vs. éxito

1. Se inicia sesión como **cliente** (`login(correo: "demo@ulsa.mx", password: "demo123")`) y se pone su token en **Headers** (`Authorization: Bearer <token>`).
2. Se ejecuta la mutación sensible:
   ```graphql
   mutation ($c: ID!) {
     registrarProducto(
       cafeteriaId: $c, nombre: "Prueba RBAC", categoria: "Bebidas",
       precio: { monto: 25, moneda: "MXN" },
       inventario: { stock: 10, puntoReorden: 2, cantidadReposicion: 10 }
     ) { id nombre }
   }
   ```
   Respuesta: `FORBIDDEN` con **HTTP 403**. En la consola sale `[PERMISO] PRODUCTO_GESTIONAR ... -> NO (Neo4j)` y el producto **no** existe en MongoDB.
3. Se repite con el token del **jefe** (`jefe@ulsa.mx`). `JEFE` no tiene el permiso directamente: lo **hereda** de `VENDEDOR` (`HEREDA_DE*0..`). El producto se crea.

### Prueba 3. Menú dinámico

Con el token de cada usuario (y sin token, como INVITADO):

```graphql
query {
  miMenu { id title path children { id title path } }
  puedoAcceder(path: "/reportes/ventas")
}
```

Cada rol recibe solo sus menús (tabla de la sección A.2): el cliente no ve *Cocina* y `puedoAcceder` regresa `false`; el jefe ve *Mi negocio* y *Más vendidos* y regresa `true`.

### Prueba 4. Inspección de tránsito en RabbitMQ UI

1. En `http://localhost:15672` (`guest` / `guest`) se abre **Queues → eventos-seguridad**.
2. Para ver los mensajes acumulados se detiene un momento el worker (`docker stop bda-worker`) y se provocan eventos: un `login` con contraseña incorrecta y uno correcto.
3. La gráfica muestra los mensajes **Ready**. En **Get messages** se ve el payload: `tipo_evento`, `usuario_id`, `email`, `motivo` y `metadata.jti`. **No aparece la contraseña, su hash ni el JWT** (CWE-532).
4. `docker start bda-worker`: los mensajes pasan a *Unacked* y luego desaparecen (ack).

### Prueba 5. Persistencia en ScyllaDB (`cqlsh`)

```bash
docker exec -it bda-scylla cqlsh -e "SELECT * FROM auditoria.logs_eventos;"
```

Los eventos aparecen agrupados por `(fecha_dia, tipo_evento)` y, dentro de cada grupo, del más reciente al más antiguo. En RabbitMQ UI la cola queda con **0 mensajes** *Ready* y *Unacked*: todos recibieron `ack`.

### Prueba 6. Simulacro de resiliencia (fail-safe)

1. `docker stop rabbitmq`
2. En la consola de la API aparece `⚠️ [RabbitMQ] Conexion cerrada. Modo degradado; reintento en 10 s.` La API **no se cae**.
3. Se hace `login`, `query { me { nombre } }` y se crea un pedido: todo responde normal. Solo se omite la auditoría.
4. `docker start rabbitmq`: en máximo 10 s la API y el worker se reconectan solos y los eventos nuevos vuelven a llegar a ScyllaDB.

### Extra: caché y revocación del JWT

- **Caché:** `productosPorCafeteria` dos veces → `[CACHE MISS] ... MongoDB` y luego `[CACHE HIT ] ... Redis: <1.5 ms`.
- **Revocación:** `login` → `query { me }` (200) → `mutation { logout }` → `query { me }` con el mismo token → **401** *"La sesion fue cerrada o expiro"*.

---

# D. Relación con la rúbrica

| Requisito | Dónde se cubre |
|---|---|
| Catálogo en Cypher: `:User`, `:Role`, `:Route`, `:MenuNode`; `HAS_ROLE`, `INHERITS`, `CAN_ACCESS`, `CAN_VIEW_MENU`, `NAVIGATES_TO`, `HAS_CHILD`; restricciones de unicidad | `neo4j/init-rbac.cql`, sección A.2 |
| `validarAccesoRuta(userId, path)` con `[:INHERITS*0..]` y `obtenerMenuUsuario(userId)` | `src/services/rbac.service.js`, sección A.2 |
| Intercepción en resolvers: 403 tipado sin escribir en MongoDB | `autorizar(...)` en `src/infrastructure/autorizacion.js`, sección A.2 |
| Productor RabbitMQ: `amqplib`, `durable: true`, `persistent: true` | `src/infrastructure/rabbitmq.js`, sección B.4 |
| Fail-safe (degradación elegante) | `src/infrastructure/rabbitmq.js`, prueba 6 |
| Mitigación CWE-532 (solo `jti`) | `src/services/auth.service.js`, prueba 4 |
| Contrapresión `prefetch(50)` | `src/worker-auditoria.js`, sección B.4 |
| Sentencias preparadas `{ prepare: true }` | `src/infrastructure/auditoria.js`, sección B.4 |
| `ack` / `nack` manual tras confirmar en ScyllaDB | `src/worker-auditoria.js`, sección B.4 |
| Tabla Query-First `((fecha_dia, tipo_evento)), timestamp, evento_id timeuuid DESC` | `auditoria.logs_eventos`, sección B.4 |
| Diagrama de secuencia integral (UML) | Sección A.4 |
| Matriz Maestra RBAC | Sección A.2 |
| Arquitectura de contenedores (Docker) | `docker-compose.yml`, `Dockerfile`, sección A.1 |
| Cache-Aside, JWT con TTL y logout (Redis) | `src/infrastructure/cache.js`, `src/infrastructure/auth.js`, secciones B.1 y B.2 |
| API Gateway GraphQL y persistencia (MongoDB) | `src/schema.graphql`, `src/resolvers/`, sección B.3 |
