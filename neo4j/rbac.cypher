// =================================================================
// Modelo RBAC multiempresa de "Pide y Recoge" en Neo4j
//
// Permisos (que puede hacer cada rol):
//   (:Usuario)-[:TIENE_ROL]->(:Rol)-[:TIENE_PERMISO]->(:Permiso)-[:SOBRE]->(:Recurso)
//   (:Rol)-[:HEREDA_DE]->(:Rol)   un rol hereda los permisos de otro
//
// Alcance (DONDE lo puede hacer). Estas relaciones las crea la API al
// registrar usuarios, negocios y cafeterias (src/infrastructure/grafo.js):
//   (:Usuario)-[:MIEMBRO_DE]->(:Escuela)       todos menos ADMIN_PLATAFORMA
//   (:Usuario)-[:ADMINISTRA]->(:Escuela)       ADMIN_ESCUELA
//   (:Usuario)-[:DUENO_DE]->(:Negocio)         JEFE
//   (:Usuario)-[:TRABAJA_EN]->(:Cafeteria)     VENDEDOR
//   (:Negocio)-[:OPERA]->(:Cafeteria)-[:PERTENECE_A]->(:Escuela)
//   (:Negocio)-[:OPERA_EN]->(:Escuela)
//
// Cada permiso tiene un alcance:
//   COMPRA     -> basta con ser MIEMBRO_DE la escuela de la cafeteria
//   GESTION    -> TRABAJA_EN la cafeteria, es DUENO_DE su negocio o ADMINISTRA su escuela
//   PLATAFORMA -> solo ADMIN_PLATAFORMA
//
// `npm run grafo` ejecuta este archivo (sin las consultas de verificacion) y
// despues copia escuelas, negocios, cafeterias y usuarios desde MongoDB.
// Tambien se puede pegar en Neo4j Browser (http://localhost:7474).
// Es repetible: usa MERGE, asi que no duplica nodos.
// =================================================================

// -----------------------------------------------------------------
// 0. Limpieza del modelo anterior (usuarios de ejemplo y roles que ya no existen)
// -----------------------------------------------------------------
MATCH (u:Usuario) WHERE u.id IN ["demo-cliente", "demo-barista", "demo-admin"]
DETACH DELETE u;

MATCH (r:Rol) WHERE r.nombre IN ["BARISTA", "ADMIN_CAFETERIA"]
DETACH DELETE r;

MATCH (p:Permiso) WHERE p.clave IN ["PRODUCTO_LEER", "PRODUCTO_REGISTRAR", "USUARIO_ADMINISTRAR"]
DETACH DELETE p;

// -----------------------------------------------------------------
// 1. Restricciones de unicidad (tambien crean un indice por propiedad)
// -----------------------------------------------------------------
CREATE CONSTRAINT usuario_id_unico IF NOT EXISTS
FOR (u:Usuario) REQUIRE u.id IS UNIQUE;

CREATE CONSTRAINT usuario_correo_unico IF NOT EXISTS
FOR (u:Usuario) REQUIRE u.correo IS UNIQUE;

CREATE CONSTRAINT rol_nombre_unico IF NOT EXISTS
FOR (r:Rol) REQUIRE r.nombre IS UNIQUE;

CREATE CONSTRAINT permiso_clave_unica IF NOT EXISTS
FOR (p:Permiso) REQUIRE p.clave IS UNIQUE;

CREATE CONSTRAINT recurso_nombre_unico IF NOT EXISTS
FOR (r:Recurso) REQUIRE r.nombre IS UNIQUE;

CREATE CONSTRAINT escuela_id_unico IF NOT EXISTS
FOR (e:Escuela) REQUIRE e.id IS UNIQUE;

CREATE CONSTRAINT negocio_id_unico IF NOT EXISTS
FOR (n:Negocio) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT cafeteria_id_unico IF NOT EXISTS
FOR (c:Cafeteria) REQUIRE c.id IS UNIQUE;

// -----------------------------------------------------------------
// 2. Recursos del dominio
// -----------------------------------------------------------------
UNWIND ["Producto", "Inventario", "Pedido", "Reporte", "Usuario",
        "Cafeteria", "Negocio", "Escuela", "Plataforma"] AS nombre
MERGE (:Recurso {nombre: nombre});

// -----------------------------------------------------------------
// 3. Permisos (accion + recurso + alcance)
// -----------------------------------------------------------------
UNWIND [
  {clave: "PEDIDO_CREAR",           accion: "CREAR",       recurso: "Pedido",     alcance: "COMPRA"},
  {clave: "PEDIDO_LEER_PROPIOS",    accion: "LEER",        recurso: "Pedido",     alcance: "COMPRA"},
  {clave: "PEDIDO_CANCELAR_PROPIO", accion: "CANCELAR",    recurso: "Pedido",     alcance: "COMPRA"},
  {clave: "PEDIDO_LEER_CAFETERIA",  accion: "LEER",        recurso: "Pedido",     alcance: "GESTION"},
  {clave: "PEDIDO_CAMBIAR_ESTADO",  accion: "ACTUALIZAR",  recurso: "Pedido",     alcance: "GESTION"},
  {clave: "INVENTARIO_REPONER",     accion: "ACTUALIZAR",  recurso: "Inventario", alcance: "GESTION"},
  {clave: "PRODUCTO_GESTIONAR",     accion: "ADMINISTRAR", recurso: "Producto",   alcance: "GESTION"},
  {clave: "VENDEDOR_REGISTRAR",     accion: "CREAR",       recurso: "Usuario",    alcance: "GESTION"},
  {clave: "CAFETERIA_REGISTRAR",    accion: "CREAR",       recurso: "Cafeteria",  alcance: "GESTION"},
  {clave: "NEGOCIO_ADMINISTRAR",    accion: "ADMINISTRAR", recurso: "Negocio",    alcance: "GESTION"},
  {clave: "REPORTE_VENTAS_LEER",    accion: "LEER",        recurso: "Reporte",    alcance: "GESTION"},
  {clave: "ESCUELA_ADMINISTRAR",    accion: "ADMINISTRAR", recurso: "Escuela",    alcance: "GESTION"},
  {clave: "REPORTE_ESCUELA_LEER",   accion: "LEER",        recurso: "Reporte",    alcance: "GESTION"},
  {clave: "PLATAFORMA_ADMINISTRAR", accion: "ADMINISTRAR", recurso: "Plataforma", alcance: "PLATAFORMA"}
] AS p
MERGE (permiso:Permiso {clave: p.clave})
SET permiso.accion = p.accion, permiso.alcance = p.alcance
WITH permiso, p
MATCH (recurso:Recurso {nombre: p.recurso})
MERGE (permiso)-[:SOBRE]->(recurso);

// -----------------------------------------------------------------
// 4. Roles y jerarquia
//    JEFE -> HEREDA_DE -> VENDEDOR -> HEREDA_DE -> CLIENTE
//    ADMIN_PLATAFORMA -> HEREDA_DE -> ADMIN_ESCUELA
// -----------------------------------------------------------------
UNWIND [
  {nombre: "CLIENTE",          descripcion: "Comprador: ve el catalogo y pide"},
  {nombre: "VENDEDOR",         descripcion: "Atiende pedidos y el menu de su cafeteria"},
  {nombre: "JEFE",             descripcion: "Dueno de un negocio con una o varias cafeterias"},
  {nombre: "ADMIN_ESCUELA",    descripcion: "Registra su escuela e invita a los negocios"},
  {nombre: "ADMIN_PLATAFORMA", descripcion: "Equipo de CafeEnLinea"}
] AS r
MERGE (rol:Rol {nombre: r.nombre})
SET rol.descripcion = r.descripcion;

UNWIND [
  ["JEFE", "VENDEDOR"],
  ["VENDEDOR", "CLIENTE"],
  ["ADMIN_PLATAFORMA", "ADMIN_ESCUELA"]
] AS par
MATCH (hijo:Rol {nombre: par[0]}), (padre:Rol {nombre: par[1]})
MERGE (hijo)-[:HEREDA_DE]->(padre);

// Permisos directos de cada rol (los heredados NO se repiten)
UNWIND [
  {rol: "CLIENTE",          permisos: ["PEDIDO_CREAR", "PEDIDO_LEER_PROPIOS", "PEDIDO_CANCELAR_PROPIO"]},
  {rol: "VENDEDOR",         permisos: ["PEDIDO_LEER_CAFETERIA", "PEDIDO_CAMBIAR_ESTADO",
                                       "INVENTARIO_REPONER", "PRODUCTO_GESTIONAR"]},
  {rol: "JEFE",             permisos: ["VENDEDOR_REGISTRAR", "CAFETERIA_REGISTRAR",
                                       "NEGOCIO_ADMINISTRAR", "REPORTE_VENTAS_LEER"]},
  {rol: "ADMIN_ESCUELA",    permisos: ["ESCUELA_ADMINISTRAR", "REPORTE_ESCUELA_LEER"]},
  {rol: "ADMIN_PLATAFORMA", permisos: ["PLATAFORMA_ADMINISTRAR"]}
] AS asignacion
MATCH (rol:Rol {nombre: asignacion.rol})
UNWIND asignacion.permisos AS clave
MATCH (permiso:Permiso {clave: clave})
MERGE (rol)-[:TIENE_PERMISO]->(permiso);

// =================================================================
// CONSULTAS DE VERIFICACION (copiar una por una en Neo4j Browser)
// Usan los usuarios demo que crea `npm run seed` + `npm run grafo`.
// =================================================================

// A) ¿El vendedor puede cambiar el estado de pedidos de SU cafeteria? (true)
MATCH (u:Usuario {correo: "vendedor@ulsa.mx"})-[:TRABAJA_EN]->(c:Cafeteria)
RETURN c.nombre AS cafeteria, EXISTS {
  (u)-[:TIENE_ROL]->(:Rol)-[:HEREDA_DE*0..]->(:Rol)-[:TIENE_PERMISO]->(:Permiso {clave: "PEDIDO_CAMBIAR_ESTADO"})
} AS autorizado;

// B) Un comprador NO puede agregar productos al menu (false)
MATCH (u:Usuario {correo: "demo@ulsa.mx"})
RETURN EXISTS {
  (u)-[:TIENE_ROL]->(:Rol)-[:HEREDA_DE*0..]->(:Rol)-[:TIENE_PERMISO]->(:Permiso {clave: "PRODUCTO_GESTIONAR"})
} AS autorizado;

// C) Todos los permisos efectivos de un usuario y por que rol le llegan
MATCH (u:Usuario {correo: "jefe@ulsa.mx"})-[:TIENE_ROL]->(rolDirecto:Rol)
MATCH (rolDirecto)-[:HEREDA_DE*0..]->(rol:Rol)-[:TIENE_PERMISO]->(p:Permiso)-[:SOBRE]->(rec:Recurso)
RETURN p.clave AS permiso, p.alcance AS alcance, rec.nombre AS recurso, rol.nombre AS otorgadoPor
ORDER BY recurso, permiso;

// D) Cafeterias que gestiona el jefe (todas las de su negocio, en cualquier escuela)
MATCH (u:Usuario {correo: "jefe@ulsa.mx"})-[:DUENO_DE]->(n:Negocio)-[:OPERA]->(c:Cafeteria)-[:PERTENECE_A]->(e:Escuela)
RETURN n.nombre AS negocio, c.nombre AS cafeteria, e.clave AS escuela;

// E) Ruta completa que justifica que el jefe gestione una cafeteria (para ver el grafo)
MATCH ruta = (u:Usuario {correo: "jefe@ulsa.mx"})-[:DUENO_DE]->(:Negocio)-[:OPERA]->(:Cafeteria)-[:PERTENECE_A]->(:Escuela)
RETURN ruta;

// F) ¿Quien puede gestionar el menu de cada cafeteria?
MATCH (c:Cafeteria)
OPTIONAL MATCH (v:Usuario)-[:TRABAJA_EN]->(c)
OPTIONAL MATCH (j:Usuario)-[:DUENO_DE]->(:Negocio)-[:OPERA]->(c)
RETURN c.nombre AS cafeteria, collect(DISTINCT v.correo) AS vendedores, collect(DISTINCT j.correo) AS jefes;

// G) Toda la estructura de una escuela
MATCH ruta = (e:Escuela {clave: "ULSA"})<-[:PERTENECE_A|MIEMBRO_DE|ADMINISTRA|OPERA_EN|OPERA|TRABAJA_EN|DUENO_DE*1..3]-()
RETURN ruta;
