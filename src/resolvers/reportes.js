// Reportes con pipelines de agregacion de MongoDB.
//
//   resumenNegocio   (JEFE)          ventas de cada cafeteria de su negocio
//   resumenEscuela   (ADMIN_ESCUELA) ventas de cada cafeteria de su escuela
//   tiemposCafeteria (JEFE)          cuanto tardan en preparar y entregar
//
// Se guardan en Redis con el TTL normal del cache (cache-aside): pueden
// mostrar datos con hasta CACHE_TTL_SEGUNDOS de retraso.

import {
  CafeteriaModel,
  PedidoModel,
  UsuarioModel,
  MonedaModel
} from "../infrastructure/mongoose-models.js";
import { requerirSesion } from "../infrastructure/auth.js";
import { autorizar } from "../infrastructure/autorizacion.js";
import { obtenerConCache } from "../infrastructure/cache.js";
import { Moneda } from "../domain/entities.js";
import { datoInvalido, validarId, mapCafeteria } from "./comun.js";

const claves = {
  negocio: id => `cache:reporte:negocio:${id}`,
  escuela: id => `cache:reporte:escuela:${id}`,
  tiempos: id => `cache:reporte:tiempos:${id}`
};

async function redondeadorDeMonedas() {
  const catalogo = await MonedaModel.find({});
  const monedas = new Map(catalogo.map(m => [m.codigo, new Moneda(m.codigo, m.simbolo, m.decimales)]));
  return (monto, codigo) => (monedas.get(codigo) ? monedas.get(codigo).redondear(monto) : monto);
}

// Pipeline: por cada cafeteria (y moneda) cuenta pedidos, entregados y
// cancelados, y suma lo vendido solo de los ENTREGADO.
async function resumenPorCafeteria(filtroCafeterias) {
  const cafeterias = await CafeteriaModel.find(filtroCafeterias).sort({ nombre: 1 });
  if (cafeterias.length === 0) return [];

  const filas = await PedidoModel.aggregate([
    // Etapa 1: solo pedidos de estas cafeterias (nunca de otra escuela o negocio)
    { $match: { cafeteriaId: { $in: cafeterias.map(c => c._id) } } },
    // Etapa 2: agrupar por cafeteria y moneda
    {
      $group: {
        _id: { cafeteriaId: "$cafeteriaId", moneda: "$total.moneda" },
        pedidos: { $sum: 1 },
        entregados: { $sum: { $cond: [{ $eq: ["$estado", "ENTREGADO"] }, 1, 0] } },
        cancelados: { $sum: { $cond: [{ $eq: ["$estado", "CANCELADO"] }, 1, 0] } },
        ingresos: { $sum: { $cond: [{ $eq: ["$estado", "ENTREGADO"] }, "$total.monto", 0] } }
      }
    },
    // Etapa 3: ticket promedio de lo entregado
    {
      $addFields: {
        ticketPromedio: {
          $cond: [{ $gt: ["$entregados", 0] }, { $divide: ["$ingresos", "$entregados"] }, 0]
        }
      }
    },
    { $sort: { ingresos: -1 } }
  ]);

  const redondear = await redondeadorDeMonedas();
  const nombres = new Map(cafeterias.map(c => [String(c._id), c.nombre]));
  const conPedidos = new Set(filas.map(f => String(f._id.cafeteriaId)));

  const resultado = filas.map(fila => ({
    cafeteriaId: fila._id.cafeteriaId,
    nombreCafeteria: nombres.get(String(fila._id.cafeteriaId)),
    pedidos: fila.pedidos,
    entregados: fila.entregados,
    cancelados: fila.cancelados,
    ingresos: { monto: redondear(fila.ingresos, fila._id.moneda), moneda: fila._id.moneda },
    ticketPromedio: { monto: redondear(fila.ticketPromedio, fila._id.moneda), moneda: fila._id.moneda }
  }));

  // Las cafeterias sin pedidos tambien aparecen, en ceros
  for (const cafeteria of cafeterias) {
    if (!conPedidos.has(String(cafeteria._id))) {
      resultado.push({
        cafeteriaId: cafeteria._id,
        nombreCafeteria: cafeteria.nombre,
        pedidos: 0,
        entregados: 0,
        cancelados: 0,
        ingresos: { monto: 0, moneda: "MXN" },
        ticketPromedio: { monto: 0, moneda: "MXN" }
      });
    }
  }
  return resultado;
}

// Pipeline: con el historial de estados calcula, por pedido, cuanto tardo de
// ACEPTADO a LISTO (preparacion) y de creado a ENTREGADO (total), y promedia.
async function calcularTiempos(cafeteriaId) {
  const [fila] = await PedidoModel.aggregate([
    { $match: { cafeteriaId, estado: "ENTREGADO" } },
    {
      $project: {
        creado: "$createdAt",
        aceptado: {
          $first: { $filter: { input: "$historial", as: "h", cond: { $eq: ["$$h.estado", "ACEPTADO"] } } }
        },
        listo: {
          $first: { $filter: { input: "$historial", as: "h", cond: { $eq: ["$$h.estado", "LISTO"] } } }
        },
        entregado: {
          $first: { $filter: { input: "$historial", as: "h", cond: { $eq: ["$$h.estado", "ENTREGADO"] } } }
        }
      }
    },
    // Solo pedidos con historial completo (los anteriores al flujo pickup no lo tienen)
    { $match: { "aceptado.fecha": { $exists: true }, "listo.fecha": { $exists: true }, "entregado.fecha": { $exists: true } } },
    {
      $group: {
        _id: null,
        pedidosMedidos: { $sum: 1 },
        preparacionMs: { $avg: { $subtract: ["$listo.fecha", "$aceptado.fecha"] } },
        totalMs: { $avg: { $subtract: ["$entregado.fecha", "$creado"] } }
      }
    }
  ]);

  const minutos = ms => (ms == null ? null : Math.round((ms / 60000) * 10) / 10);
  return {
    pedidosMedidos: fila?.pedidosMedidos ?? 0,
    promedioPreparacionMin: minutos(fila?.preparacionMs),
    promedioTotalMin: minutos(fila?.totalMs)
  };
}

export const resolversReportes = {
  ResumenCafeteria: {
    cafeteria: async resumen => {
      const doc = await CafeteriaModel.findById(resumen.cafeteriaId);
      return doc ? mapCafeteria(doc) : null;
    }
  },

  Query: {
    // Sin negocioId usa el negocio del JEFE que pregunta
    resumenNegocio: async (_, { negocioId }, contexto) => {
      let id = negocioId;
      if (!id) {
        const { usuarioId } = requerirSesion(contexto);
        const usuario = await UsuarioModel.findById(usuarioId);
        if (!usuario?.negocioId) throw datoInvalido("Tu cuenta no tiene un negocio.");
        id = usuario.negocioId;
      }
      validarId(id, "negocio");
      await autorizar(contexto, "REPORTE_VENTAS_LEER", { negocioId: id });
      return obtenerConCache(claves.negocio(id), () => resumenPorCafeteria({ negocioId: id }));
    },

    resumenEscuela: async (_, { escuelaId }, contexto) => {
      validarId(escuelaId, "escuela");
      await autorizar(contexto, "REPORTE_ESCUELA_LEER", { escuelaId });
      return obtenerConCache(claves.escuela(escuelaId), () => resumenPorCafeteria({ escuelaId }));
    },

    tiemposCafeteria: async (_, { cafeteriaId }, contexto) => {
      validarId(cafeteriaId, "cafeteria");
      await autorizar(contexto, "REPORTE_VENTAS_LEER", { cafeteriaId });
      const cafeteria = await CafeteriaModel.findById(cafeteriaId);
      if (!cafeteria) throw datoInvalido("La cafeteria no existe.");
      return obtenerConCache(claves.tiempos(cafeteriaId), () => calcularTiempos(cafeteria._id));
    }
  }
};
