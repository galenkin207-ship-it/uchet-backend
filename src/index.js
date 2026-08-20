import { app } from "./app.js";
import "dotenv/config";

const port = Number(process.env.PORT || 3001);
app.listen(port, "127.0.0.1", () => {
  console.log(`uchet-server слушает на 127.0.0.1:${port}`);
});
