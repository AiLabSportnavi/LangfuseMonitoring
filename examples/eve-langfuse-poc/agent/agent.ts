import { defineAgent } from "eve";

import { resolveModel } from "./model.js";

export default defineAgent({
  model: resolveModel(),
});
