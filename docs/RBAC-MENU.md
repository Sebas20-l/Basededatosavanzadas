# RBAC por rutas y navegación dinámica con Neo4j

Motor de autorización de Café en Línea modelado como un **Grafo Acíclico Dirigido (DAG)** en Neo4j.
Valida el acceso a rutas por **herencia de roles** y separa la **estructura visual del menú** de las
**rutas técnicas protegidas**.

| Archivo | Qué contiene |
|---|---|
| [`neo4j/init-rbac.cql`](../neo4j/init-rbac.cql) | Restricciones, roles, herencia, rutas y árbol de menú |
| [`src/services/rbac.service.js`](../src/services/rbac.service.js) | `validarAccesoRuta`, `obtenerMenuUsuario`, `rutasPermitidas` |
| [`src/resolvers/rbac.js`](../src/resolvers/rbac.js) | Queries GraphQL `miMenu`, `puedoAcceder`, `misRutas` |
| [`src/infrastructure/grafo.js`](../src/infrastructure/grafo.js) | Copia cada usuario de MongoDB como `(:User)-[:HAS_ROLE]->(:Role)` |

---

## 1. Modelo del grafo

```
(:User {id}) ──[:HAS_ROLE]──> (:Role {name})
                                   │
                              [:INHERITS*0..]
                                   ▼
                             (:Role {name})
                              ├──[:CAN_ACCESS]────> (:Route {path})
                              └──[:CAN_VIEW_MENU]─> (:MenuNode {id, title, order})
                                                          │ [:HAS_CHILD]
                                                          ▼
                                                    (:MenuNode) ──[:NAVIGATES_TO]──> (:Route)
```

**4 etiquetas:** `User`, `Role`, `Route`, `MenuNode`.
**6 relaciones:** `HAS_ROLE`, `INHERITS`, `CAN_ACCESS`, `CAN_VIEW_MENU`, `HAS_CHILD`, `NAVIGATES_TO`.

**Restricciones de unicidad** (evitan duplicados y crean el índice de cada llave):
`unique_user_id`, `unique_role_name`, `unique_route_path`, `unique_menu_id`.

> El nodo `:User` es el mismo nodo `:Usuario` que ya usaba el sistema (lleva las dos etiquetas).
> Su `id` es el `_id` del usuario en MongoDB, la fuente de verdad.

## 2. Jerarquía de roles (5 niveles)

```
ADMIN_PLATAFORMA ──► JEFE ──► VENDEDOR ──► CLIENTE ──► INVITADO
        └──────────► ADMIN_ESCUELA ───────────┘
```

| Rol | Quién es | Rutas propias | Rutas efectivas |
|---|---|---|---|
| `INVITADO` | Sin sesión | 6 | 6 |
| `CLIENTE` | Alumno o maestro | 6 | 12 |
| `ADMIN_ESCUELA` | Administra su escuela | 2 | 14 |
| `VENDEDOR` | Atiende una cafetería | 5 | 17 |
| `JEFE` | Dueño del negocio | 5 | 22 |
| `ADMIN_PLATAFORMA` | Equipo de Café en Línea | 2 | 26 |

- Es un **DAG**: la herencia va siempre de arriba hacia abajo y no hay ciclos (consulta B del script = 0).
- `ADMIN_ESCUELA` y `JEFE` llegan a `CLIENTE` por caminos distintos (forma de diamante), algo que un árbol no permite y un grafo sí.
- Cada ruta se liga con `CAN_ACCESS` **solo al rol más bajo** que la usa. Los superiores la obtienen por transitividad con `[:INHERITS*0..]` (`*0..` incluye al propio rol).

## 3. Menú desacoplado de las rutas

- **Ruta** (`:Route`) = lo que el servidor protege. **Botón** (`:MenuNode`) = lo que se dibuja.
- Un botón puede no tener ruta (solo agrupa submenús, como *Cocina*).
- Una ruta puede no tener botón: `/login` y `/registro` son de `INVITADO`, pero no aparecen en el menú, porque todos los roles los heredarían y no tiene sentido mostrárselos a alguien con sesión.
- Cambiar el menú (orden, títulos, agrupación) no toca permisos, y al revés.

## 4. Consultas del servicio (`rbac.service.js`)

**Validar ruta**: la consulta de la actividad, sin cambios:

```cypher
MATCH (u:User {id: $userId})-[:HAS_ROLE]->(r:Role)
MATCH (r)-[:INHERITS*0..]->(effectiveRole:Role)-[:CAN_ACCESS]->(rt:Route {path: $path})
RETURN count(rt) > 0 AS autorizado
```

**Menú del usuario**: versión corregida.

En la consulta de la actividad, un submenú solo aparece si lo otorga **el mismo rol** que otorgó a su
menú padre (`WHERE (effectiveRole)-[:CAN_VIEW_MENU]->(child)`). En este modelo, *Menú de la cafetería*
es de `VENDEDOR` y su hijo *Más vendidos* es de `JEFE`: con la consulta original el jefe **no** ve *Más
vendidos*, aunque hereda los dos roles (comprobado: regresa solo 3 de 4 hijos).

La corrección junta primero **todos** los roles efectivos y filtra cada hijo contra ese conjunto:

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
WITH parent, rtParent, child, rtChild ORDER BY child.order
RETURN parent.id AS id, parent.title AS title, parent.order AS order, rtParent.path AS path,
       collect(DISTINCT CASE WHEN child IS NOT NULL THEN
         {id: child.id, title: child.title, order: child.order, path: rtChild.path} END) AS children
ORDER BY order
```

Las dos usan sesiones de solo lectura (`defaultAccessMode: READ`), que el driver puede mandar a una réplica.
Sin sesión, ambas parten del rol `INVITADO`.

## 5. Queries GraphQL

```graphql
query {
  miMenu { id title order path children { id title order path } }
  puedoAcceder(path: "/reportes/ventas")
  misRutas
}
```

En Apollo Sandbox: primero `login`, luego en **Headers** `Authorization: Bearer <token>`.

### Resultado por rol (usuarios demo, contraseña `demo123`)

| Usuario | Rol | Menús raíz que ve | `/cocina/cola` | `/reportes/ventas` |
|---|---|---|---|---|
| *(sin sesión)* | INVITADO | Explorar | ❌ | ❌ |
| `demo@ulsa.mx` | CLIENTE | + Inicio, Comprar, Mis pedidos, Perfil | ❌ | ❌ |
| `vendedor@ulsa.mx` | VENDEDOR | + Cocina, Menú de la cafetería (3 hijos) | ✅ | ❌ |
| `jefe@ulsa.mx` | JEFE | + Mi negocio, y *Más vendidos* en Menú de la cafetería | ✅ | ✅ |
| `admin@ulsa.mx` | ADMIN_ESCUELA | CLIENTE + Mi escuela | ❌ | ❌ |
| `admin@cafeenlinea.mx` | ADMIN_PLATAFORMA | Todo + Plataforma | ✅ | ✅ |

## 6. Cómo cargarlo

```bash
npm run grafo     # carga rbac.cypher + init-rbac.cql y copia los usuarios de MongoDB
```

También se puede pegar `neo4j/init-rbac.cql` en Neo4j Browser. Al final del archivo están las
consultas de verificación (jerarquía, ciclos, rutas por rol, árbol de menú) para las capturas.
