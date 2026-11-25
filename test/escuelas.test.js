import { test } from "node:test";
import assert from "node:assert/strict";
import {
  limpiarTexto,
  claveBaseDeNombre,
  claveCandidata
} from "../src/domain/escuelas.js";

const FORMATO_CLAVE = /^[A-Z0-9]{2,12}$/;

test("limpiarTexto quita espacios de mas", () => {
  assert.equal(limpiarTexto("  Universidad   La  Salle "), "Universidad La Salle");
  assert.equal(limpiarTexto(null), "");
});

test("la clave usa las iniciales sin palabras vacias ni acentos", () => {
  assert.equal(claveBaseDeNombre("Universidad La Salle"), "US");
  assert.equal(claveBaseDeNombre("Instituto Tecnológico de Chihuahua"), "ITC");
  assert.equal(claveBaseDeNombre("Preparatoria 2 de Octubre"), "P2O");
});

test("un nombre de una sola palabra usa sus primeras letras", () => {
  assert.equal(claveBaseDeNombre("Tecnológico"), "TECNOL");
});

test("la clave siempre cumple el formato del modelo Escuela", () => {
  for (const nombre of ["U", "!!!", "de la", "Ñandú", "A".repeat(200), "a b c d e f g h i j k l m n"]) {
    const base = claveBaseDeNombre(nombre);
    assert.match(base, FORMATO_CLAVE, `clave de "${nombre}"`);
    assert.match(claveCandidata(base, 50), FORMATO_CLAVE, `candidata de "${nombre}"`);
  }
});

test("las candidatas agregan un numero a partir del segundo intento", () => {
  assert.equal(claveCandidata("US", 1), "US");
  assert.equal(claveCandidata("US", 2), "US2");
});
