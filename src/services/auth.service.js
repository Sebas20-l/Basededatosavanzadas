// Casos de uso de autenticacion, instrumentados con eventos de seguridad.
//
// Los eventos se mandan a RabbitMQ sin esperar respuesta (Fire-and-Forget):
// la auditoria nunca hace mas lento ni bloquea el login.
//
// Regla CWE-532 (no filtrar credenciales en logs): los eventos NUNCA llevan
// la contrasena ni el token JWT. Del token solo va su jti (id de la sesion),
// que por si solo no sirve para autenticarse.

import bcrypt from "bcryptjs";
import { UsuarioModel } from "../infrastructure/mongoose-models.js";
import { iniciarSesion, noAutorizado } from "../infrastructure/auth.js";
import { emitirEventoSeguridad } from "../infrastructure/rabbitmq.js";

const ipDe = contexto => contexto?.ip || "127.0.0.1";

export const authService = {
  // Devuelve { token, expiraEn, doc } o lanza "Correo o contrasena incorrectos."
  async login(correo, password, contexto) {
    // Se aplica la misma normalizacion usada al registrar la cuenta.
    const emailNormalizado = String(correo ?? "").trim().toLowerCase();
    const user = await UsuarioModel.findOne({ correo: emailNormalizado }).select("+passwordHash");
    // No revela si fallo el correo o la contrasena; compara contra el hash guardado.
    const valido = user?.passwordHash && (await bcrypt.compare(password, user.passwordHash));

    if (!valido) {
      // 1. Login fallido
      emitirEventoSeguridad({
        tipo_evento: "LOGIN_FAILED",
        usuario_id: user ? user._id.toString() : "ANONYMOUS",
        email: emailNormalizado,
        ip_origen: ipDe(contexto),
        exito: false,
        motivo: !user ? "Usuario inexistente" : "Contraseña incorrecta",
        metadata: {}
      });
      throw noAutorizado("Correo o contrasena incorrectos.");
    }

    const { token, expiraEn, jti } = await iniciarSesion(user);

    // 2. Login exitoso (solo el jti, nunca el token completo)
    emitirEventoSeguridad({
      tipo_evento: "LOGIN_SUCCESS",
      usuario_id: user._id.toString(),
      email: user.correo,
      ip_origen: ipDe(contexto),
      exito: true,
      motivo: "Credenciales válidas",
      metadata: { rol: user.rol, jti }
    });

    return { token, expiraEn, doc: user };
  },

  // 3. Registro de usuario. Se llama DESPUES de guardar (y de confirmar la
  //    transaccion), para no auditar altas que se revirtieron.
  auditarRegistro(doc, contexto) {
    emitirEventoSeguridad({
      tipo_evento: "USER_REGISTERED",
      usuario_id: doc._id.toString(),
      email: doc.correo,
      ip_origen: ipDe(contexto),
      exito: true,
      motivo: "Alta en el sistema",
      metadata: { rolInicial: doc.rol }
    });
  }
};

// 4. Cambio de privilegios: se emite desde src/infrastructure/grafo.js
//    (sincronizarUsuario), que es donde cambia la relacion HAS_ROLE del grafo.
