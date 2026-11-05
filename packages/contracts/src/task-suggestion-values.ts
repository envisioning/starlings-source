/**
 * Words a task title is read without when two proposals are compared for
 * sameness: English, Portuguese and German function words, after diacritic
 * folding. The Worker's suggestion evaluator reads this list; the generator
 * writes it into `ContractConstants.taskSuggestionStopwords` for the Swift
 * heuristics (`Sources/TaskSuggestion.swift`).
 */
export const TASK_SUGGESTION_STOPWORDS = [
  'the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'on', 'in', 'with', 'by', 'at',
  'our', 'your', 'their', 'this', 'that', 'it', 'is', 'are', 'be', 'will', 's',
  'o', 'os', 'as', 'um', 'uma', 'de', 'da', 'do', 'das', 'dos', 'para', 'com', 'no', 'na',
  'der', 'die', 'den', 'dem', 'ein', 'eine', 'und', 'fur', 'mit', 'auf', 'im',
] as const;
