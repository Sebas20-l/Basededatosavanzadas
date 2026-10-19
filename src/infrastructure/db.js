import mongoose from "mongoose";

const mongoUri = process.env.MONGODB_URI || "mongodb://admin:password123@localhost:27017/pide_y_recoge?authSource=admin";

// Atlas mete usuario y contrasena dentro de la cadena de conexion:
// nunca se debe imprimir completa en la consola ni en los logs.
function ocultarCredenciales(uri) {
  return uri.replace(/\/\/[^@/]+@/, "//***@");
}

// crearPedido usa transacciones, y MongoDB solo las permite en un replica set.
// Atlas siempre lo es; un Mongo local suelto (el del docker-compose) no.
async function avisarSiNoEsReplicaSet() {
  try {
    const info = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!info.setName) {
      console.warn(
        "AVISO: este MongoDB no es un replica set. crearPedido va a fallar porque " +
        "usa transacciones. Usa MongoDB Atlas o un replica set local."
      );
    }
  } catch {
    // Si el usuario no puede ejecutar 'hello', no es un problema critico.
  }
}

export async function conectarBaseDatos() {
  try {
    await mongoose.connect(mongoUri);
    console.log("MongoDB conectado correctamente:", ocultarCredenciales(mongoUri));
    console.log("Base de datos en uso:", mongoose.connection.name);
  } catch (error) {
    console.error("No se pudo conectar a MongoDB:", error.message);
    process.exit(1);
  }
  await avisarSiNoEsReplicaSet();
}