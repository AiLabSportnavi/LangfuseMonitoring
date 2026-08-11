import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Deterministic and offline on purpose. The tool is not what is under test —
 * it exists so a turn produces a multi-step trace with a real tool span, which
 * is what makes the Langfuse trace tree worth auditing.
 */
export default defineTool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({
    city: z.string().describe("City name, for example Berlin"),
  }),
  execute: async ({ city }) => {
    const table: Record<string, { tempC: number; conditions: string }> = {
      berlin: { tempC: 19, conditions: "overcast" },
      hamburg: { tempC: 17, conditions: "light rain" },
      munich: { tempC: 23, conditions: "sunny" },
    };

    return table[city.toLowerCase()] ?? { tempC: 20, conditions: "unknown" };
  },
});
