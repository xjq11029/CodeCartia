import express from "express";
const app = express();
app.get("/item/:id", (req, res, next) => {
  if (req.params.id === "0") return next("route");
  res.send("first");
  return;
});
app.get("/item/:id", (req, res) => {
  res.send("second");
});
export { app };
