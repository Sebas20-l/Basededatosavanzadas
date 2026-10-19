// =================================================================
// Modelo RBAC de "Pide y Recoge" en Neo4j
//
// (:Usuario)-[:TIENE_ROL]->(:Rol)-[:TIENE_PERMISO]->(:Permiso)-[:SOBRE]->(:Recurso)
// (:Rol)-[:HEREDA_DE]->(:Rol)   jerarquia: un rol hereda los permisos de otro
//
// Se puede pegar completo en Neo4j Browser (http://localhost:7474) o correr con:
//   docker exec -i bda-neo4j cypher-shell -u neo4j -p password123 < neo4j/rbac.cypher
// Es repetible: usa MERGE, asi que no duplica nodos.
// =================================================================

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

// -----------------------------------------------------------------
// 2. Recursos del dominio
// -----------------------------------------------------------------
UNWIND ["Producto", "Inventario", "Pedido", "Reporte", "Usuario"] AS nombre
MERGE (:Recurso {nombre: nombre});

// -----------------------------------------------------------------
// 3. Permisos (accion + recurso)
// -----------------------------------------------------------------
UNWIND [
  {clave: "PRODUCTO_LEER",          accion: "LEER",       recurso: "Producto"},
  {clave: "PRODUCTO_REGISTRAR",     accion: "CREAR",      recurso: "Producto"},
  {clave: "INVENTARIO_REPONER",     accion: "ACTUALIZAR", recurso: "Inventario"},
  {clave: "PEDIDO_CREAR",           accion: "CREAR",      recurso: "Pedido"},
  {clave: "PEDIDO_LEER_PROPIOS",    accion: "LEER",       recurso: "Pedido"},
  {clave: "PEDIDO_LEER_CAFETERIA",  accion: "LEER",       recurso: "Pedido"},
  {clave: "PEDIDO_CAMBIAR_ESTADO",  accion: "ACTUALIZAR", recurso: "Pedido"},
  {clave: "REPORTE_VENTAS_LEER",    accion: "LEER",       recurso: "Reporte"},
  {clave: "USUARIO_ADMINISTRAR",    accion: "ADMINISTRAR", recurso: "Usuario"}
] AS p
MERGE (permiso:Permiso {clave: p.clave})
SET permiso.accion = p.accion
WITH permiso, p
MATCH (recurso:Recurso {nombre: p.recurso})
MERGE (permiso)-[:SOBRE]->(recurso);

// -----------------------------------------------------------------
// 4. Roles y jerarquia
//    ADMIN_CAFETERIA -> HEREDA_DE -> BARISTA -> HEREDA_DE -> CLIENTE
// -----------------------------------------------------------------
UNWIND [
  {nombre: "CLIENTE",         descripcion: "Alumno o docente que pide comida"},
  {nombre: "BARISTA",         descripcion: "Personal que prepara y entrega pedidos"},
  {nombre: "ADMIN_CAFETERIA", descripcion: "Encargado de la cafeteria"}
] AS r
MERGE (rol:Rol {nombre: r.nombre})
SET rol.descripcion = r.descripcion;

MATCH (admin:Rol {nombre: "ADMIN_CAFETERIA"}), (barista:Rol {nombre: "BARISTA"}),
      (cliente:Rol {nombre: "CLIENTE"})
MERGE (admin)-[:HEREDA_DE]->(barista)
MERGE (barista)-[:HEREDA_DE]->(cliente);

// Permisos directos de cada rol (los heredados NO se repiten)
UNWIND [
  {rol: "CLIENTE",         permisos: ["PRODUCTO_LEER", "PEDIDO_CREAR", "PEDIDO_LEER_PROPIOS"]},
  {rol: "BARISTA",         permisos: ["PEDIDO_LEER_CAFETERIA", "PEDIDO_CAMBIAR_ESTADO", "INVENTARIO_REPONER"]},
  {rol: "ADMIN_CAFETERIA", permisos: ["PRODUCTO_REGISTRAR", "REPORTE_VENTAS_LEER", "USUARIO_ADMINISTRAR"]}
] AS asignacion
MATCH (rol:Rol {nombre: asignacion.rol})
UNWIND asignacion.permisos AS clave
MATCH (permiso:Permiso {clave: clave})
MERGE (rol)-[:TIENE_PERMISO]->(permiso);

// -----------------------------------------------------------------
// 5. Usuarios de ejemplo (u.id = _id del usuario en MongoDB)
// -----------------------------------------------------------------
UNWIND [
  {id: "demo-cliente", correo: "demo@ulsa.mx",      rol: "CLIENTE"},
  {id: "demo-barista", correo: "barista@ulsa.mx",   rol: "BARISTA"},
  {id: "demo-admin",   correo: "admin@ulsa.mx",     rol: "ADMIN_CAFETERIA"}
] AS u
MERGE (usuario:Usuario {id: u.id})
SET usuario.correo = u.correo
WITH usuario, u
MATCH (rol:Rol {nombre: u.rol})
MERGE (usuario)-[:TIENE_ROL]->(rol);

// =================================================================
// CONSULTAS DE VERIFICACION (copiar una por una en Neo4j Browser)
// =================================================================

// A) ¿El usuario puede ejecutar este permiso? (incluye roles heredados: *0..)
//    true  -> autorizado ; false -> 403 Forbidden
MATCH (u:Usuario {correo: "admin@ulsa.mx"})
RETURN EXISTS {
  (u)-[:TIENE_ROL]->(:Rol)-[:HEREDA_DE*0..]->(:Rol)-[:TIENE_PERMISO]->(:Permiso {clave: "PEDIDO_CREAR"})
} AS autorizado;

// B) Un cliente NO puede ver el reporte de ventas (debe dar false)
MATCH (u:Usuario {correo: "demo@ulsa.mx"})
RETURN EXISTS {
  (u)-[:TIENE_ROL]->(:Rol)-[:HEREDA_DE*0..]->(:Rol)-[:TIENE_PERMISO]->(:Permiso {clave: "REPORTE_VENTAS_LEER"})
} AS autorizado;

// C) Todos los permisos efectivos de un usuario y por que rol le llegan
MATCH (u:Usuario {correo: "barista@ulsa.mx"})-[:TIENE_ROL]->(rolDirecto:Rol)
MATCH (rolDirecto)-[:HEREDA_DE*0..]->(rol:Rol)-[:TIENE_PERMISO]->(p:Permiso)-[:SOBRE]->(rec:Recurso)
RETURN p.clave AS permiso, p.accion AS accion, rec.nombre AS recurso, rol.nombre AS otorgadoPor
ORDER BY recurso, permiso;

// D) Ruta completa que justifica un acceso (para mostrar el grafo en el Browser)
MATCH ruta = (u:Usuario {correo: "admin@ulsa.mx"})-[:TIENE_ROL]->(:Rol)
             -[:HEREDA_DE*0..]->(:Rol)-[:TIENE_PERMISO]->(:Permiso {clave: "PEDIDO_CREAR"})
             -[:SOBRE]->(:Recurso)
RETURN ruta;

// E) ¿Quien puede actualizar el inventario?
MATCH (p:Permiso {clave: "INVENTARIO_REPONER"})<-[:TIENE_PERMISO]-(:Rol)<-[:HEREDA_DE*0..]-(:Rol)<-[:TIENE_ROL]-(u:Usuario)
RETURN DISTINCT u.correo AS usuario;
