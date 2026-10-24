import { loadConfig } from "./src/core/config";
import { connectDb } from "./src/core/db";

await loadConfig();
await connectDb();

console.log("RUNNING");
