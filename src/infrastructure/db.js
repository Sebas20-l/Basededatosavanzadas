import mongoose from "mongoose";

const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/pide_y_recoge";

export async function conectarBaseDatos() {
  try {
    await mongoose.connect(mongoUri);
    console.log("MongoDB conectado correctamente:", mongoUri);
  } catch (error) {
    console.error("No se pudo conectar a MongoDB:", error.message);
    process.exit(1);
  }
}
