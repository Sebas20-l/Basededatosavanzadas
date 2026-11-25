// Reglas para las escuelas que los alumnos escriben al registrarse.
// Son funciones puras (sin base de datos) para poder probarlas solas.

export const NOMBRE_ESCUELA_MIN = 3;
export const NOMBRE_ESCUELA_MAX = 120;
export const CIUDAD_MAX = 80;

// Palabras que no aportan a la clave: "Universidad de La Salle" -> "US"
const PALABRAS_VACIAS = new Set(["DE", "DEL", "LA", "LAS", "EL", "LOS", "Y", "E", "EN"]);

// Quita espacios de mas: "  Universidad   La Salle " -> "Universidad La Salle"
export const limpiarTexto = texto => String(texto ?? "").trim().replace(/\s+/g, " ");

export const sinAcentos = texto => texto.normalize("NFD").replace(/[̀-ͯ]/g, "");

// Clave legible a partir del nombre (iniciales), con el formato que exige el
// modelo Escuela: de 2 a 12 letras o numeros. La unicidad se resuelve aparte.
export function claveBaseDeNombre(nombre) {
  const palabras = sinAcentos(limpiarTexto(nombre))
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(" ")
    .filter(Boolean);
  const utiles = palabras.filter(p => !PALABRAS_VACIAS.has(p));
  const fuente = utiles.length > 0 ? utiles : palabras;

  let clave = fuente.map(p => (/^\d+$/.test(p) ? p : p[0])).join("");
  // Una sola palabra ("Tecnologico") -> sus primeras letras
  if (clave.length < 2) clave = fuente.join("").slice(0, 6);
  if (clave.length < 2) clave = "ESC";
  return clave.slice(0, 8);
}

// Candidatas de clave en orden: "US", "US2", "US3", ...
export function claveCandidata(base, intento) {
  return intento <= 1 ? base : `${base}${intento}`;
}
