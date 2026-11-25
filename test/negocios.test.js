import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ESTADOS_NEGOCIO,
  validarCambioEstadoNegocio,
  cafeteriasVisibles
} from "../src/domain/negocios.js";

const { EN_REVISION, APROBADO, RECHAZADO } = ESTADOS_NEGOCIO;

test("un negocio en revision se puede aprobar o rechazar", () => {
  assert.doesNotThrow(() => validarCambioEstadoNegocio(EN_REVISION, APROBADO));
  assert.doesNotThrow(() => validarCambioEstadoNegocio(EN_REVISION, RECHAZADO));
});

test("un rechazado se puede reconsiderar y un aprobado dar de baja", () => {
  assert.doesNotThrow(() => validarCambioEstadoNegocio(RECHAZADO, APROBADO));
  assert.doesNotThrow(() => validarCambioEstadoNegocio(APROBADO, RECHAZADO));
});

test("no se repite el mismo estado ni se regresa a revision", () => {
  assert.throws(() => validarCambioEstadoNegocio(APROBADO, APROBADO));
  assert.throws(() => validarCambioEstadoNegocio(RECHAZADO, RECHAZADO));
  assert.throws(() => validarCambioEstadoNegocio(APROBADO, EN_REVISION));
  assert.throws(() => validarCambioEstadoNegocio(EN_REVISION, "BORRADO"));
});

test("los negocios de antes (sin estado) cuentan como aprobados", () => {
  assert.doesNotThrow(() => validarCambioEstadoNegocio(undefined, RECHAZADO));
  assert.equal(cafeteriasVisibles(undefined), true);
  assert.equal(cafeteriasVisibles(EN_REVISION), false);
  assert.equal(cafeteriasVisibles(RECHAZADO), false);
  assert.equal(cafeteriasVisibles(APROBADO), true);
});
