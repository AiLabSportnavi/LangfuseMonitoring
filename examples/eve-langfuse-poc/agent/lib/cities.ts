/**
 * The single source of truth for which cities this agent knows about.
 *
 * WHY THIS EXISTS
 *
 * The city table was duplicated three times: in `get_weather`, in `get_forecast`,
 * and in the prose of the system prompt ("Only supports Berlin, Hamburg and
 * Munich"). Three copies of the same fact drift, and the prompt copy is the one
 * that drifts silently — a city added to the tools but not to the prompt makes the
 * agent refuse a request it could have served, with no error anywhere.
 *
 * Exporting it here lets the tools read it directly and lets the prompt receive it
 * as a Langfuse prompt VARIABLE, so the prompt text stays generic and the deployed
 * value is always the real list.
 */

export interface CityWeather {
  tempC: number;
  conditions: string;
}

/** Keys are lowercase: callers normalise before lookup. */
export const CITY_WEATHER: Record<string, CityWeather> = {
  berlin: { tempC: 19, conditions: "overcast" },
  hamburg: { tempC: 17, conditions: "light rain" },
  munich: { tempC: 23, conditions: "sunny" },
};

/**
 * What `get_weather` returns for a city it does not know.
 *
 * Deliberately a plausible-looking reading rather than an error, because that is
 * the realistic shape of a third-party weather API — and it is precisely what makes
 * hallucination possible here: the model is handed a number for a place with no
 * data. The `no-fabricated-data` evaluator and the `hallucination-*` dataset items
 * both key off this sentinel.
 */
export const UNKNOWN_CITY: CityWeather = { tempC: 20, conditions: "unknown" };

/** Title-cased names for display, e.g. "Berlin, Hamburg and Munich". */
export function supportedCityNames(): string[] {
  return Object.keys(CITY_WEATHER).map((city) => city.charAt(0).toUpperCase() + city.slice(1));
}

/** Renders the list the way a sentence needs it: "Berlin, Hamburg and Munich". */
export function supportedCitiesSentence(): string {
  const names = supportedCityNames();
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
