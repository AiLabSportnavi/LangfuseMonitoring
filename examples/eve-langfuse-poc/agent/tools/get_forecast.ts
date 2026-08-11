import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * A second tool, so a turn can chain tool calls and the trace has to show the
 * order and data flow between them rather than a single isolated call.
 *
 * It throws for cities it does not cover. That failure path is deliberate: an
 * error that is never exercised is an error path that was never verified to be
 * traceable, and "where did it fail" is one of the questions the trace has to
 * answer.
 */
export default defineTool({
  description:
    "Get a multi-day forecast for a city. Only supports Berlin, Hamburg and Munich.",
  inputSchema: z.object({
    city: z.string().describe("City name, for example Berlin"),
    days: z.number().int().min(1).max(5).describe("How many days to forecast"),
  }),
  execute: async ({ city, days }) => {
    const baseline: Record<string, number> = { berlin: 19, hamburg: 17, munich: 23 };
    const start = baseline[city.toLowerCase()];

    if (start === undefined) {
      throw new Error(
        `No forecast coverage for "${city}". Supported cities: Berlin, Hamburg, Munich.`,
      );
    }

    return {
      city,
      days: Array.from({ length: days }, (_, index) => ({
        dayOffset: index + 1,
        tempC: start + ((index % 3) - 1),
      })),
    };
  },
});
