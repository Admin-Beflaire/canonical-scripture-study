-- P3: language aids are found through aid_entries (0010), so the four partial indexes on
-- JSON expressions over annotations.details_json that served them are no longer used.
DROP INDEX annotations_lexicon_entry_key;
DROP INDEX annotations_lexicon_strong_base;
DROP INDEX annotations_grammar_code;
DROP INDEX annotations_proper_name_tag;
