// @ts-check
/**
 * @fileoverview Static data for the (content-triggered, best-effort) Adaptive Card
 * `"type"` and version checks in src/adaptivecard.js.
 *
 * Source of truth: the real, machine-readable Adaptive Card JSON Schema
 * published by Microsoft at https://adaptivecards.microsoft.com/schemas/adaptive-card.json
 * (formerly adaptivecards.io, which now redirects there; fetched 2026-09-25,
 * versions re-checked 2026-09-28; schema `$schema`: draft-06). `ADAPTIVE_CARD_TYPES` is
 * every `definitions.*` entry that declares a `type` property with a single
 * const/enum value matching its own definition name -- i.e. every string
 * that can legitimately appear as a `"type": "..."` discriminator somewhere
 * in a card. Definitions without such a discriminator (enums like `Colors`
 * or `FontSize`, and schema-composition helpers like `ImplementationsOf.*` /
 * `Extendable.*`) are deliberately excluded -- they're never a `"type"` value.
 * Each entry also carries the definition's own `version` (the first card
 * version that supports it), used by the `adaptivecard-version-too-low` check.
 *
 * This is a hand-maintained snapshot, same maintenance model as
 * language-data.js: re-fetch the schema URL above and re-derive this list if
 * Adaptive Cards ships new element/action types.
 */

/**
 * Every Adaptive Card `"type"` value, mapped to the first card schema version
 * that supports it (the definition's own `version` in the schema; `"1.0"`
 * where the schema declares none).
 * @type {ReadonlyMap<string, string>}
 */
const ADAPTIVE_CARD_TYPES = new Map([
  ["Action.Execute", "1.4"],
  ["Action.OpenUrl", "1.0"],
  ["Action.ShowCard", "1.0"],
  ["Action.Submit", "1.0"],
  ["Action.ToggleVisibility", "1.2"],
  ["AdaptiveCard", "1.0"],
  ["ActionSet", "1.2"],
  ["Column", "1.0"],
  ["ColumnSet", "1.0"],
  ["Container", "1.0"],
  ["Fact", "1.0"],
  ["FactSet", "1.0"],
  ["Image", "1.0"],
  ["ImageSet", "1.0"],
  ["Input.Choice", "1.0"],
  ["Input.ChoiceSet", "1.0"],
  ["Input.Date", "1.0"],
  ["Input.Number", "1.0"],
  ["Input.Text", "1.0"],
  ["Input.Time", "1.0"],
  ["Input.Toggle", "1.0"],
  ["Media", "1.1"],
  ["MediaSource", "1.1"],
  ["RichTextBlock", "1.2"],
  ["Table", "1.5"],
  ["TableCell", "1.5"],
  ["TableColumnDefinition", "1.5"],
  ["TableRow", "1.5"],
  ["TextBlock", "1.0"],
  ["TextRun", "1.2"],
  ["Authentication", "1.4"],
  ["BackgroundImage", "1.2"],
  ["Refresh", "1.4"],
  ["TokenExchangeResource", "1.4"],
]);

module.exports = {
  ADAPTIVE_CARD_TYPES,
};
