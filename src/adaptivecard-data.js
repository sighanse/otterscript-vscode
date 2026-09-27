// @ts-check
/**
 * @fileoverview Static data for the (content-triggered, best-effort) Adaptive Card
 * `"type"` check in src/adaptivecard.js.
 *
 * Source of truth: the real, machine-readable Adaptive Card JSON Schema
 * published by Microsoft at https://adaptivecards.io/schemas/adaptive-card.json
 * (fetched 2026-09-25; schema `$schema`: draft-06). `ADAPTIVE_CARD_TYPES` is
 * every `definitions.*` entry that declares a `type` property with a single
 * const/enum value matching its own definition name -- i.e. every string
 * that can legitimately appear as a `"type": "..."` discriminator somewhere
 * in a card. Definitions without such a discriminator (enums like `Colors`
 * or `FontSize`, and schema-composition helpers like `ImplementationsOf.*` /
 * `Extendable.*`) are deliberately excluded -- they're never a `"type"` value.
 *
 * This is a hand-maintained snapshot, same maintenance model as
 * language-data.js: re-fetch the schema URL above and re-derive this list if
 * Adaptive Cards ships new element/action types.
 */

/** @type {ReadonlySet<string>} */
const ADAPTIVE_CARD_TYPES = new Set([
  "Action.Execute",
  "Action.OpenUrl",
  "Action.ShowCard",
  "Action.Submit",
  "Action.ToggleVisibility",
  "AdaptiveCard",
  "ActionSet",
  "Column",
  "ColumnSet",
  "Container",
  "Fact",
  "FactSet",
  "Image",
  "ImageSet",
  "Input.Choice",
  "Input.ChoiceSet",
  "Input.Date",
  "Input.Number",
  "Input.Text",
  "Input.Time",
  "Input.Toggle",
  "Media",
  "MediaSource",
  "RichTextBlock",
  "Table",
  "TableCell",
  "TableColumnDefinition",
  "TableRow",
  "TextBlock",
  "Authentication",
  "BackgroundImage",
  "Refresh",
  "TokenExchangeResource",
]);

module.exports = {
  ADAPTIVE_CARD_TYPES,
};
