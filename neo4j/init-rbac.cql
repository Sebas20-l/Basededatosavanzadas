// =====================================================================
// init-rbac.cql — RBAC por rutas y menu dinamico de Cafe en Linea
// =====================================================================
//
// Modelo (Grafo Aciclico Dirigido):
//
//   (:User {id}) -[:HAS_ROLE]-> (:Role {name})
//   (:Role) -[:INHERITS]-> (:Role)            rol superior -> rol inferior
//   (:Role) -[:CAN_ACCESS]-> (:Route {path})  solo en el rol MAS BAJO que la usa
//   (:Role) -[:CAN_VIEW_MENU]-> (:MenuNode {id, title, order})
//   (:MenuNode) -[:HAS_CHILD]-> (:MenuNode)   submenus
//   (:MenuNode) -[:NAVIGATES_TO]-> (:Route)   a donde lleva el clic
//
// Jerarquia (5 niveles):
//
//   ADMIN_PLATAFORMA -> JEFE -> VENDEDOR -> CLIENTE -> INVITADO
//   ADMIN_PLATAFORMA -> ADMIN_ESCUELA ------> CLIENTE
//
// Los nodos :User NO se crean aqui: son el mismo nodo :Usuario que
// src/infrastructure/grafo.js copia desde MongoDB (se le agrega la etiqueta
// :User y la relacion HAS_ROLE). Este script se carga con `npm run grafo`
// o pegandolo en Neo4j Browser. Es repetible: correrlo dos veces no duplica.
//
// Convive con neo4j/rbac.cypher (permisos por accion: :Rol, :Permiso),
// porque usa otras etiquetas.
// =====================================================================


// ---------------------------------------------------------------------
// 1. Restricciones de unicidad (tambien crean el indice de cada llave)
// ---------------------------------------------------------------------
CREATE CONSTRAINT unique_user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE;
CREATE CONSTRAINT unique_role_name IF NOT EXISTS FOR (r:Role) REQUIRE r.name IS UNIQUE;
CREATE CONSTRAINT unique_route_path IF NOT EXISTS FOR (rt:Route) REQUIRE rt.path IS UNIQUE;
CREATE CONSTRAINT unique_menu_id IF NOT EXISTS FOR (m:MenuNode) REQUIRE m.id IS UNIQUE;


// ---------------------------------------------------------------------
// 2. Limpieza para que el script sea repetible
//    Se borran rutas, menu y herencias; los roles se conservan porque
//    los usuarios ya estan ligados a ellos con HAS_ROLE.
// ---------------------------------------------------------------------
MATCH (n) WHERE n:Route OR n:MenuNode
DETACH DELETE n;

MATCH (:Role)-[h:INHERITS]->(:Role)
DELETE h;


// ---------------------------------------------------------------------
// 3. Roles
// ---------------------------------------------------------------------
UNWIND [
  {name: "INVITADO",         descripcion: "Sin sesion: explora escuelas y menus"},
  {name: "CLIENTE",          descripcion: "Alumno o maestro: pide y recoge"},
  {name: "VENDEDOR",         descripcion: "Atiende la cocina y el menu de una cafeteria"},
  {name: "JEFE",             descripcion: "Dueno del negocio y sus cafeterias"},
  {name: "ADMIN_ESCUELA",    descripcion: "Administra su escuela e invita negocios"},
  {name: "ADMIN_PLATAFORMA", descripcion: "Equipo de Cafe en Linea"}
] AS r
MERGE (rol:Role {name: r.name})
SET rol.descripcion = r.descripcion;


// ---------------------------------------------------------------------
// 4. Herencia (rSuperior)-[:INHERITS]->(rInferior)
// ---------------------------------------------------------------------
UNWIND [
  ["ADMIN_PLATAFORMA", "JEFE"],
  ["ADMIN_PLATAFORMA", "ADMIN_ESCUELA"],
  ["JEFE",             "VENDEDOR"],
  ["VENDEDOR",         "CLIENTE"],
  ["ADMIN_ESCUELA",    "CLIENTE"],
  ["CLIENTE",          "INVITADO"]
] AS par
MATCH (superior:Role {name: par[0]}), (inferior:Role {name: par[1]})
MERGE (superior)-[:INHERITS]->(inferior);


// ---------------------------------------------------------------------
// 5. Rutas del sistema, ligadas SOLO al rol mas bajo que las usa.
//    Los roles superiores las obtienen por transitividad (INHERITS*0..).
// ---------------------------------------------------------------------
UNWIND [
  // INVITADO: pantallas sin sesion
  {path: "/onboarding",              rol: "INVITADO",         descripcion: "Bienvenida de la app"},
  {path: "/login",                   rol: "INVITADO",         descripcion: "Inicio de sesion"},
  {path: "/registro",                rol: "INVITADO",         descripcion: "Crear cuenta"},
  {path: "/terminos",                rol: "INVITADO",         descripcion: "Terminos y condiciones"},
  {path: "/escuelas",                rol: "INVITADO",         descripcion: "Catalogo de escuelas y cafeterias"},
  {path: "/menu",                    rol: "INVITADO",         descripcion: "Menu de una cafeteria"},

  // CLIENTE: comprar y recoger
  {path: "/inicio",                  rol: "CLIENTE",          descripcion: "Pantalla principal"},
  {path: "/carrito",                 rol: "CLIENTE",          descripcion: "Carrito y confirmacion del pedido"},
  {path: "/pedidos",                 rol: "CLIENTE",          descripcion: "Mis pedidos y codigo de recogida"},
  {path: "/notificaciones",          rol: "CLIENTE",          descripcion: "Avisos de mis pedidos"},
  {path: "/perfil",                  rol: "CLIENTE",          descripcion: "Mi cuenta"},
  {path: "/perfil/seguridad",        rol: "CLIENTE",          descripcion: "Biometria y sesion"},

  // VENDEDOR: cocina y menu de su cafeteria
  {path: "/cocina/cola",             rol: "VENDEDOR",         descripcion: "Cola de cocina en tiempo real"},
  {path: "/cocina/pedidos",          rol: "VENDEDOR",         descripcion: "Pedidos de la cafeteria"},
  {path: "/productos",               rol: "VENDEDOR",         descripcion: "Productos del menu"},
  {path: "/productos/nuevo",         rol: "VENDEDOR",         descripcion: "Agregar platillo"},
  {path: "/inventario/reponer",      rol: "VENDEDOR",         descripcion: "Productos por reponer"},

  // JEFE: negocio y reportes
  {path: "/negocio/cafeterias",      rol: "JEFE",             descripcion: "Cafeterias del negocio"},
  {path: "/negocio/vendedores",      rol: "JEFE",             descripcion: "Alta de vendedores"},
  {path: "/reportes/ventas",         rol: "JEFE",             descripcion: "Resumen de ventas por cafeteria"},
  {path: "/reportes/horas-pico",     rol: "JEFE",             descripcion: "Ventas por hora"},
  {path: "/reportes/mas-vendidos",   rol: "JEFE",             descripcion: "Productos mas vendidos"},

  // ADMIN_ESCUELA
  {path: "/escuela/invitacion",      rol: "ADMIN_ESCUELA",    descripcion: "Codigo de invitacion para negocios"},
  {path: "/escuela/reporte",         rol: "ADMIN_ESCUELA",    descripcion: "Reporte de la escuela"},

  // ADMIN_PLATAFORMA
  {path: "/plataforma/escuelas",     rol: "ADMIN_PLATAFORMA", descripcion: "Suspender o reactivar escuelas"},
  {path: "/plataforma/monedas",      rol: "ADMIN_PLATAFORMA", descripcion: "Catalogo de monedas"}
] AS r
MATCH (rol:Role {name: r.rol})
MERGE (ruta:Route {path: r.path})
SET ruta.descripcion = r.descripcion
MERGE (rol)-[:CAN_ACCESS]->(ruta);


// ---------------------------------------------------------------------
// 6. Arbol de menu desacoplado de las rutas
//    padre = null -> menu raiz; ruta = null -> solo agrupa submenus.
//    rol = rol mas bajo que VE ese boton (CAN_VIEW_MENU).
//
//    Nota de diseno: /login y /registro tienen ruta pero NO boton de menu
//    (un usuario con sesion los heredaria y no tiene sentido mostrarlos).
//    "Mas vendidos" es un submenu de JEFE dentro de un menu de VENDEDOR:
//    el vendedor ve el menu padre pero no ese hijo.
// ---------------------------------------------------------------------
UNWIND [
  // Raices
  {id: "explorar",               title: "Explorar",               order: 1, padre: null,          ruta: null,                      rol: "INVITADO"},
  {id: "inicio",                 title: "Inicio",                 order: 2, padre: null,          ruta: "/inicio",                 rol: "CLIENTE"},
  {id: "comprar",                title: "Comprar",                order: 3, padre: null,          ruta: null,                      rol: "CLIENTE"},
  {id: "mis-pedidos",            title: "Mis pedidos",            order: 4, padre: null,          ruta: null,                      rol: "CLIENTE"},
  {id: "cocina",                 title: "Cocina",                 order: 5, padre: null,          ruta: null,                      rol: "VENDEDOR"},
  {id: "menu-cafeteria",         title: "Menu de la cafeteria",   order: 6, padre: null,          ruta: null,                      rol: "VENDEDOR"},
  {id: "mi-negocio",             title: "Mi negocio",             order: 7, padre: null,          ruta: null,                      rol: "JEFE"},
  {id: "mi-escuela",             title: "Mi escuela",             order: 8, padre: null,          ruta: null,                      rol: "ADMIN_ESCUELA"},
  {id: "plataforma",             title: "Plataforma",             order: 9, padre: null,          ruta: null,                      rol: "ADMIN_PLATAFORMA"},
  {id: "perfil",                 title: "Perfil",                 order: 10, padre: null,         ruta: "/perfil",                 rol: "CLIENTE"},

  // Explorar
  {id: "explorar-escuelas",      title: "Escuelas y cafeterias",  order: 1, padre: "explorar",    ruta: "/escuelas",               rol: "INVITADO"},
  {id: "explorar-terminos",      title: "Terminos y condiciones", order: 2, padre: "explorar",    ruta: "/terminos",               rol: "INVITADO"},

  // Comprar
  {id: "comprar-menu",           title: "Menu",                   order: 1, padre: "comprar",     ruta: "/menu",                   rol: "CLIENTE"},
  {id: "comprar-carrito",        title: "Carrito",                order: 2, padre: "comprar",     ruta: "/carrito",                rol: "CLIENTE"},

  // Mis pedidos
  {id: "pedidos-lista",          title: "Pedidos",                order: 1, padre: "mis-pedidos", ruta: "/pedidos",                rol: "CLIENTE"},
  {id: "pedidos-avisos",         title: "Notificaciones",         order: 2, padre: "mis-pedidos", ruta: "/notificaciones",         rol: "CLIENTE"},

  // Cocina
  {id: "cocina-cola",            title: "Cola de pedidos",        order: 1, padre: "cocina",      ruta: "/cocina/cola",            rol: "VENDEDOR"},
  {id: "cocina-pedidos",         title: "Pedidos del dia",        order: 2, padre: "cocina",      ruta: "/cocina/pedidos",         rol: "VENDEDOR"},

  // Menu de la cafeteria
  {id: "menu-productos",         title: "Productos",              order: 1, padre: "menu-cafeteria", ruta: "/productos",           rol: "VENDEDOR"},
  {id: "menu-nuevo",             title: "Agregar platillo",       order: 2, padre: "menu-cafeteria", ruta: "/productos/nuevo",     rol: "VENDEDOR"},
  {id: "menu-reponer",           title: "Reponer inventario",     order: 3, padre: "menu-cafeteria", ruta: "/inventario/reponer",  rol: "VENDEDOR"},
  {id: "menu-mas-vendidos",      title: "Mas vendidos",           order: 4, padre: "menu-cafeteria", ruta: "/reportes/mas-vendidos", rol: "JEFE"},

  // Mi negocio
  {id: "negocio-cafeterias",     title: "Cafeterias",             order: 1, padre: "mi-negocio",  ruta: "/negocio/cafeterias",     rol: "JEFE"},
  {id: "negocio-vendedores",     title: "Vendedores",             order: 2, padre: "mi-negocio",  ruta: "/negocio/vendedores",     rol: "JEFE"},
  {id: "negocio-ventas",         title: "Reporte de ventas",      order: 3, padre: "mi-negocio",  ruta: "/reportes/ventas",        rol: "JEFE"},
  {id: "negocio-horas-pico",     title: "Horas pico",             order: 4, padre: "mi-negocio",  ruta: "/reportes/horas-pico",    rol: "JEFE"},

  // Mi escuela
  {id: "escuela-invitacion",     title: "Codigo de invitacion",   order: 1, padre: "mi-escuela",  ruta: "/escuela/invitacion",     rol: "ADMIN_ESCUELA"},
  {id: "escuela-reporte",        title: "Reporte de la escuela",  order: 2, padre: "mi-escuela",  ruta: "/escuela/reporte",        rol: "ADMIN_ESCUELA"},

  // Plataforma
  {id: "plataforma-escuelas",    title: "Escuelas",               order: 1, padre: "plataforma",  ruta: "/plataforma/escuelas",    rol: "ADMIN_PLATAFORMA"},
  {id: "plataforma-monedas",     title: "Monedas",                order: 2, padre: "plataforma",  ruta: "/plataforma/monedas",     rol: "ADMIN_PLATAFORMA"}
] AS m
MATCH (rol:Role {name: m.rol})
MERGE (nodo:MenuNode {id: m.id})
SET nodo.title = m.title, nodo.order = m.order
MERGE (rol)-[:CAN_VIEW_MENU]->(nodo)
// FOREACH sobre una lista de 0 o 1 elementos = "solo si tiene ruta / padre"
FOREACH (_ IN CASE WHEN m.ruta IS NULL THEN [] ELSE [1] END |
  MERGE (ruta:Route {path: m.ruta})
  MERGE (nodo)-[:NAVIGATES_TO]->(ruta)
)
FOREACH (_ IN CASE WHEN m.padre IS NULL THEN [] ELSE [1] END |
  MERGE (padre:MenuNode {id: m.padre})
  MERGE (padre)-[:HAS_CHILD]->(nodo)
);


// =====================================================================
// CONSULTAS DE VERIFICACION (no se ejecutan con `npm run grafo`;
// copialas en Neo4j Browser)
// =====================================================================

// A. Jerarquia completa de roles
// MATCH p = (:Role)-[:INHERITS*]->(:Role) RETURN p;

// B. ¿El grafo de herencia es aciclico? (debe regresar 0)
// MATCH (r:Role)-[:INHERITS*1..]->(r) RETURN count(r) AS ciclos;

// C. Rutas efectivas de cada rol (propias + heredadas)
// MATCH (r:Role)-[:INHERITS*0..]->(:Role)-[:CAN_ACCESS]->(rt:Route)
// RETURN r.name AS rol, count(DISTINCT rt) AS rutas, collect(DISTINCT rt.path) AS paths
// ORDER BY rutas;

// D. Arbol de menu con a donde navega cada boton
// MATCH p = (:MenuNode)-[:HAS_CHILD]->(:MenuNode)-[:NAVIGATES_TO]->(:Route) RETURN p;

// E. ¿Un usuario puede entrar a una ruta?
// MATCH (u:User {id: "<id>"})-[:HAS_ROLE]->(r:Role)
// MATCH (r)-[:INHERITS*0..]->(:Role)-[:CAN_ACCESS]->(rt:Route {path: "/reportes/ventas"})
// RETURN count(rt) > 0 AS autorizado;

// F. Todo el modelo de un usuario (para captura)
// MATCH p = (:User {id: "<id>"})-[:HAS_ROLE]->(:Role)-[:INHERITS*0..]->(:Role)-[:CAN_VIEW_MENU]->(:MenuNode)
// RETURN p;
