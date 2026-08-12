import { defineTool } from "eve/tools";
import { z } from "zod";

import { CITY_WEATHER, UNKNOWN_CITY } from "../lib/cities.ts";

/**
 * Deterministic and offline on purpose. The tool is not what is under test —
 * it exists so a turn produces a multi-step trace with a real tool span, which
 * is what makes the Langfuse trace tree worth auditing.
 *
 * The city table lives in `../lib/cities.ts` so the tools and the system prompt
 * cannot disagree about which cities are supported: the prompt receives the same
 * list as a Langfuse prompt variable.
 */
export default defineTool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({
    city: z.string().describe("City name, for example Berlin"),
  }),
  execute: async ({ city }) => {
    return CITY_WEATHER[city.toLowerCase()] ?? UNKNOWN_CITY;
  },
});
